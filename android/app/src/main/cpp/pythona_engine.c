#include <Python.h>

#include <jni.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>


/* One Android service process owns one persistent main interpreter. */
static JavaVM *g_vm = NULL;
static pthread_mutex_t g_state_mutex = PTHREAD_MUTEX_INITIALIZER;
static bool g_initialized = false;
static char *g_python_home = NULL;
static PyThreadState *g_main_thread_state = NULL;

static pthread_mutex_t g_callback_mutex = PTHREAD_MUTEX_INITIALIZER;
static jobject g_callback = NULL;
static jmethodID g_output_method = NULL;
static jmethodID g_input_method = NULL;

typedef struct InputNode {
    char *text;
    struct InputNode *next;
} InputNode;

static pthread_mutex_t g_input_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_input_condition = PTHREAD_COND_INITIALIZER;
static InputNode *g_input_head = NULL;
static InputNode *g_input_tail = NULL;
static char *g_active_run_id = NULL;
static atomic_bool g_run_cancelled = ATOMIC_VAR_INIT(false);
static atomic_ulong g_active_python_thread = ATOMIC_VAR_INIT(0);

typedef struct CancelNode {
    char *request_id;
    struct CancelNode *next;
} CancelNode;

static pthread_mutex_t g_cancel_mutex = PTHREAD_MUTEX_INITIALIZER;
static CancelNode *g_cancelled_requests = NULL;
static size_t g_cancelled_request_count = 0;


static void throw_java(JNIEnv *env, const char *class_name, const char *message) {
    if ((*env)->ExceptionCheck(env)) {
        return;
    }
    jclass type = (*env)->FindClass(env, class_name);
    if (type != NULL) {
        (*env)->ThrowNew(env, type, message != NULL ? message : "native error");
        (*env)->DeleteLocalRef(env, type);
    }
}


static char *duplicate_string(const char *value) {
    if (value == NULL) {
        return NULL;
    }
    size_t length = strlen(value);
    char *copy = malloc(length + 1);
    if (copy != NULL) {
        memcpy(copy, value, length + 1);
    }
    return copy;
}


/* JNI uses modified UTF-8. Convert through UTF-16 so emoji and lone
 * surrogates never corrupt JSON, paths, arguments, or console input. */
static char *jstring_to_utf8(JNIEnv *env, jstring value) {
    if (value == NULL) {
        return duplicate_string("");
    }
    jsize length = (*env)->GetStringLength(env, value);
    const jchar *characters = (*env)->GetStringChars(env, value, NULL);
    if (characters == NULL) {
        return NULL;
    }
    size_t capacity = (size_t)length * 3 + 1;
    char *output = malloc(capacity);
    if (output == NULL) {
        (*env)->ReleaseStringChars(env, value, characters);
        throw_java(env, "java/lang/OutOfMemoryError", "UTF-8 conversion allocation failed");
        return NULL;
    }

    size_t offset = 0;
    for (jsize index = 0; index < length; index++) {
        uint32_t codepoint = characters[index];
        if (codepoint >= 0xD800 && codepoint <= 0xDBFF
            && index + 1 < length
            && characters[index + 1] >= 0xDC00
            && characters[index + 1] <= 0xDFFF) {
            codepoint = 0x10000
                + ((codepoint - 0xD800) << 10)
                + (characters[++index] - 0xDC00);
        } else if (codepoint >= 0xD800 && codepoint <= 0xDFFF) {
            codepoint = 0xFFFD;
        }

        if (codepoint <= 0x7F) {
            output[offset++] = (char)codepoint;
        } else if (codepoint <= 0x7FF) {
            output[offset++] = (char)(0xC0 | (codepoint >> 6));
            output[offset++] = (char)(0x80 | (codepoint & 0x3F));
        } else if (codepoint <= 0xFFFF) {
            output[offset++] = (char)(0xE0 | (codepoint >> 12));
            output[offset++] = (char)(0x80 | ((codepoint >> 6) & 0x3F));
            output[offset++] = (char)(0x80 | (codepoint & 0x3F));
        } else {
            output[offset++] = (char)(0xF0 | (codepoint >> 18));
            output[offset++] = (char)(0x80 | ((codepoint >> 12) & 0x3F));
            output[offset++] = (char)(0x80 | ((codepoint >> 6) & 0x3F));
            output[offset++] = (char)(0x80 | (codepoint & 0x3F));
        }
    }
    output[offset] = '\0';
    (*env)->ReleaseStringChars(env, value, characters);
    return output;
}


static jstring python_unicode_to_jstring(JNIEnv *env, PyObject *unicode) {
    if (!PyUnicode_Check(unicode)) {
        PyErr_SetString(PyExc_TypeError, "Python host must return str");
        return NULL;
    }
    Py_ssize_t length = PyUnicode_GetLength(unicode);
    if (length < 0 || length > INT32_MAX / 2) {
        if (!PyErr_Occurred()) {
            PyErr_SetString(PyExc_OverflowError, "Python string is too large for JNI");
        }
        return NULL;
    }
    jchar *buffer = malloc(((size_t)length * 2 + 1) * sizeof(jchar));
    if (buffer == NULL) {
        PyErr_NoMemory();
        return NULL;
    }

    jsize units = 0;
    for (Py_ssize_t index = 0; index < length; index++) {
        Py_UCS4 codepoint = PyUnicode_ReadChar(unicode, index);
        if (codepoint == (Py_UCS4)-1 && PyErr_Occurred()) {
            free(buffer);
            return NULL;
        }
        if (codepoint <= 0xFFFF) {
            buffer[units++] = (jchar)codepoint;
        } else {
            codepoint -= 0x10000;
            buffer[units++] = (jchar)(0xD800 + (codepoint >> 10));
            buffer[units++] = (jchar)(0xDC00 + (codepoint & 0x3FF));
        }
    }
    jstring result = (*env)->NewString(env, buffer, units);
    free(buffer);
    return result;
}


static jstring utf8_to_jstring(JNIEnv *env, const char *value) {
    PyObject *unicode = PyUnicode_DecodeUTF8(
        value != NULL ? value : "",
        (Py_ssize_t)strlen(value != NULL ? value : ""),
        "replace");
    if (unicode == NULL) {
        return NULL;
    }
    jstring result = python_unicode_to_jstring(env, unicode);
    Py_DECREF(unicode);
    return result;
}


static char *format_python_exception(void) {
    PyObject *type = NULL;
    PyObject *value = NULL;
    PyObject *traceback = NULL;
    PyErr_Fetch(&type, &value, &traceback);
    PyErr_NormalizeException(&type, &value, &traceback);

    char *message = NULL;
    PyObject *traceback_module = PyImport_ImportModule("traceback");
    if (traceback_module != NULL) {
        PyObject *formatted = PyObject_CallMethod(
            traceback_module,
            "format_exception",
            "OOO",
            type != NULL ? type : Py_None,
            value != NULL ? value : Py_None,
            traceback != NULL ? traceback : Py_None);
        if (formatted != NULL) {
            PyObject *separator = PyUnicode_FromString("");
            PyObject *joined = separator != NULL
                ? PyUnicode_Join(separator, formatted)
                : NULL;
            if (joined != NULL) {
                const char *utf8 = PyUnicode_AsUTF8(joined);
                if (utf8 != NULL) {
                    message = duplicate_string(utf8);
                }
                Py_DECREF(joined);
            }
            Py_XDECREF(separator);
            Py_DECREF(formatted);
        }
        Py_DECREF(traceback_module);
    }
    PyErr_Clear();
    if (message == NULL && value != NULL) {
        PyObject *string = PyObject_Str(value);
        if (string != NULL) {
            const char *utf8 = PyUnicode_AsUTF8(string);
            if (utf8 != NULL) {
                message = duplicate_string(utf8);
            }
            Py_DECREF(string);
        }
        PyErr_Clear();
    }
    Py_XDECREF(type);
    Py_XDECREF(value);
    Py_XDECREF(traceback);
    return message != NULL ? message : duplicate_string("embedded Python call failed");
}


static void throw_python_exception(JNIEnv *env) {
    char *message = format_python_exception();
    throw_java(env, "java/lang/IllegalStateException", message);
    free(message);
}


static JNIEnv *current_env(bool *attached) {
    *attached = false;
    if (g_vm == NULL) {
        return NULL;
    }
    JNIEnv *env = NULL;
    jint status = (*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
        if ((*g_vm)->AttachCurrentThread(g_vm, &env, NULL) != JNI_OK) {
            return NULL;
        }
        *attached = true;
    } else if (status != JNI_OK) {
        return NULL;
    }
    return env;
}


static jobject local_callback(JNIEnv *env) {
    pthread_mutex_lock(&g_callback_mutex);
    jobject callback = g_callback != NULL
        ? (*env)->NewLocalRef(env, g_callback)
        : NULL;
    pthread_mutex_unlock(&g_callback_mutex);
    return callback;
}


static char *active_run_id_copy(void) {
    pthread_mutex_lock(&g_input_mutex);
    char *copy = duplicate_string(g_active_run_id != NULL ? g_active_run_id : "");
    pthread_mutex_unlock(&g_input_mutex);
    return copy;
}


static int emit_output(PyObject *stream, PyObject *text) {
    bool attached;
    JNIEnv *env = current_env(&attached);
    if (env == NULL) {
        PyErr_SetString(PyExc_RuntimeError, "Android callback thread is unavailable");
        return -1;
    }
    jobject callback = local_callback(env);
    if (callback == NULL) {
        if (attached) {
            (*g_vm)->DetachCurrentThread(g_vm);
        }
        return 0;
    }

    char *run_id = active_run_id_copy();
    jstring java_run_id = utf8_to_jstring(env, run_id != NULL ? run_id : "");
    jstring java_stream = python_unicode_to_jstring(env, stream);
    jstring java_text = python_unicode_to_jstring(env, text);
    free(run_id);
    if (java_run_id == NULL || java_stream == NULL || java_text == NULL) {
        (*env)->DeleteLocalRef(env, callback);
        if (attached) {
            (*g_vm)->DetachCurrentThread(g_vm);
        }
        return -1;
    }
    (*env)->CallVoidMethod(
        env, callback, g_output_method, java_run_id, java_stream, java_text);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
    }
    (*env)->DeleteLocalRef(env, java_run_id);
    (*env)->DeleteLocalRef(env, java_stream);
    (*env)->DeleteLocalRef(env, java_text);
    (*env)->DeleteLocalRef(env, callback);
    if (attached) {
        (*g_vm)->DetachCurrentThread(g_vm);
    }
    return 0;
}


static int emit_input_requested(PyObject *prompt) {
    bool attached;
    JNIEnv *env = current_env(&attached);
    if (env == NULL) {
        PyErr_SetString(PyExc_RuntimeError, "Android callback thread is unavailable");
        return -1;
    }
    jobject callback = local_callback(env);
    if (callback == NULL) {
        if (attached) {
            (*g_vm)->DetachCurrentThread(g_vm);
        }
        return 0;
    }

    char *run_id = active_run_id_copy();
    jstring java_run_id = utf8_to_jstring(env, run_id != NULL ? run_id : "");
    jstring java_prompt = python_unicode_to_jstring(env, prompt);
    free(run_id);
    if (java_run_id == NULL || java_prompt == NULL) {
        (*env)->DeleteLocalRef(env, callback);
        if (attached) {
            (*g_vm)->DetachCurrentThread(g_vm);
        }
        return -1;
    }
    (*env)->CallVoidMethod(env, callback, g_input_method, java_run_id, java_prompt);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
    }
    (*env)->DeleteLocalRef(env, java_run_id);
    (*env)->DeleteLocalRef(env, java_prompt);
    (*env)->DeleteLocalRef(env, callback);
    if (attached) {
        (*g_vm)->DetachCurrentThread(g_vm);
    }
    return 0;
}


static void clear_input_queue_locked(void) {
    InputNode *node = g_input_head;
    while (node != NULL) {
        InputNode *next = node->next;
        free(node->text);
        free(node);
        node = next;
    }
    g_input_head = NULL;
    g_input_tail = NULL;
}


static bool request_is_cancelled(const char *request_id) {
    bool found = false;
    pthread_mutex_lock(&g_cancel_mutex);
    for (CancelNode *node = g_cancelled_requests; node != NULL; node = node->next) {
        if (strcmp(node->request_id, request_id) == 0) {
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&g_cancel_mutex);
    return found;
}


static void cancel_request(const char *request_id) {
    if (request_id == NULL || request_id[0] == '\0') {
        return;
    }
    pthread_mutex_lock(&g_cancel_mutex);
    for (CancelNode *node = g_cancelled_requests; node != NULL; node = node->next) {
        if (strcmp(node->request_id, request_id) == 0) {
            pthread_mutex_unlock(&g_cancel_mutex);
            return;
        }
    }
    CancelNode *node = calloc(1, sizeof(*node));
    if (node != NULL) {
        node->request_id = duplicate_string(request_id);
        if (node->request_id != NULL) {
            node->next = g_cancelled_requests;
            g_cancelled_requests = node;
            g_cancelled_request_count++;
        } else {
            free(node);
        }
    }
    /* Bound abandoned cancellation IDs even if a caller never dispatches them. */
    if (g_cancelled_request_count > 1024) {
        CancelNode *current = g_cancelled_requests;
        CancelNode *previous = NULL;
        size_t kept = 0;
        while (current != NULL) {
            kept++;
            if (kept > 768) {
                if (previous != NULL) {
                    previous->next = NULL;
                }
                while (current != NULL) {
                    CancelNode *next = current->next;
                    free(current->request_id);
                    free(current);
                    current = next;
                    g_cancelled_request_count--;
                }
                break;
            }
            previous = current;
            current = current->next;
        }
    }
    pthread_mutex_unlock(&g_cancel_mutex);
}


static void clear_cancelled_request(const char *request_id) {
    pthread_mutex_lock(&g_cancel_mutex);
    CancelNode **link = &g_cancelled_requests;
    while (*link != NULL) {
        CancelNode *node = *link;
        if (strcmp(node->request_id, request_id) == 0) {
            *link = node->next;
            free(node->request_id);
            free(node);
            g_cancelled_request_count--;
            break;
        }
        link = &node->next;
    }
    pthread_mutex_unlock(&g_cancel_mutex);
}


/* --- Built-in _pythona_native module ------------------------------------ */

static PyObject *bridge_write(PyObject *self, PyObject *args) {
    (void)self;
    PyObject *stream;
    PyObject *text;
    if (!PyArg_ParseTuple(args, "UU:write", &stream, &text)) {
        return NULL;
    }
    if (emit_output(stream, text) != 0) {
        return NULL;
    }
    Py_RETURN_NONE;
}


static PyObject *bridge_read_input(PyObject *self, PyObject *args) {
    (void)self;
    PyObject *prompt;
    if (!PyArg_ParseTuple(args, "U:read_input", &prompt)) {
        return NULL;
    }
    if (emit_input_requested(prompt) != 0) {
        return NULL;
    }

    PyThreadState *saved = PyEval_SaveThread();
    pthread_mutex_lock(&g_input_mutex);
    while (g_input_head == NULL
           && g_active_run_id != NULL
           && !atomic_load_explicit(&g_run_cancelled, memory_order_acquire)) {
        pthread_cond_wait(&g_input_condition, &g_input_mutex);
    }
    bool cancelled = atomic_load_explicit(&g_run_cancelled, memory_order_acquire);
    InputNode *node = g_input_head;
    if (node != NULL) {
        g_input_head = node->next;
        if (g_input_head == NULL) {
            g_input_tail = NULL;
        }
    }
    pthread_mutex_unlock(&g_input_mutex);
    PyEval_RestoreThread(saved);

    if (cancelled) {
        if (node != NULL) {
            free(node->text);
            free(node);
        }
        PyErr_SetNone(PyExc_KeyboardInterrupt);
        return NULL;
    }
    if (node == NULL) {
        PyErr_SetString(PyExc_EOFError, "PythonA input stream closed");
        return NULL;
    }
    PyObject *result = PyUnicode_DecodeUTF8(
        node->text,
        (Py_ssize_t)strlen(node->text),
        "strict");
    free(node->text);
    free(node);
    return result;
}


static PyObject *bridge_cancelled(PyObject *self, PyObject *args) {
    (void)self;
    if (!PyArg_ParseTuple(args, ":cancelled")) {
        return NULL;
    }
    return PyBool_FromLong(
        atomic_load_explicit(&g_run_cancelled, memory_order_acquire));
}


static PyObject *bridge_cancel_request(PyObject *self, PyObject *args) {
    (void)self;
    const char *request_id;
    if (!PyArg_ParseTuple(args, "s:cancel_request", &request_id)) {
        return NULL;
    }
    cancel_request(request_id);
    Py_RETURN_NONE;
}


static PyObject *bridge_is_request_cancelled(PyObject *self, PyObject *args) {
    (void)self;
    const char *request_id;
    if (!PyArg_ParseTuple(args, "s:is_request_cancelled", &request_id)) {
        return NULL;
    }
    return PyBool_FromLong(request_is_cancelled(request_id));
}


static PyObject *bridge_clear_request_cancelled(PyObject *self, PyObject *args) {
    (void)self;
    const char *request_id;
    if (!PyArg_ParseTuple(args, "s:clear_request_cancelled", &request_id)) {
        return NULL;
    }
    clear_cancelled_request(request_id);
    Py_RETURN_NONE;
}

static PyMethodDef bridge_methods[] = {
    {"write", bridge_write, METH_VARARGS, "Forward a Unicode console chunk."},
    {"read_input", bridge_read_input, METH_VARARGS, "Wait for one console line."},
    {"cancelled", bridge_cancelled, METH_VARARGS, "Return runtime cancellation state."},
    {"cancel_request", bridge_cancel_request, METH_VARARGS, "Cancel a language request."},
    {"is_request_cancelled", bridge_is_request_cancelled, METH_VARARGS, "Check language cancellation."},
    {"clear_request_cancelled", bridge_clear_request_cancelled, METH_VARARGS, "Clear language cancellation."},
    {NULL, NULL, 0, NULL},
};


static struct PyModuleDef bridge_module = {
    PyModuleDef_HEAD_INIT,
    "_pythona_native",
    "PythonA native runtime and language-service primitives.",
    -1,
    bridge_methods,
    NULL,
    NULL,
    NULL,
    NULL,
};


PyMODINIT_FUNC PyInit__pythona_native(void) {
    return PyModule_Create(&bridge_module);
}


/* --- Interpreter lifecycle and Java API --------------------------------- */

static int attach_callbacks(JNIEnv *env, jobject owner) {
    jclass type = (*env)->GetObjectClass(env, owner);
    if (type == NULL) {
        return -1;
    }
    jmethodID output = (*env)->GetMethodID(
        env,
        type,
        "dispatchOutput",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");
    jmethodID input = (*env)->GetMethodID(
        env,
        type,
        "dispatchInputRequested",
        "(Ljava/lang/String;Ljava/lang/String;)V");
    (*env)->DeleteLocalRef(env, type);
    if (output == NULL || input == NULL) {
        return -1;
    }
    jobject global = (*env)->NewGlobalRef(env, owner);
    if (global == NULL) {
        return -1;
    }

    pthread_mutex_lock(&g_callback_mutex);
    jobject previous = g_callback;
    g_callback = global;
    g_output_method = output;
    g_input_method = input;
    pthread_mutex_unlock(&g_callback_mutex);
    if (previous != NULL) {
        (*env)->DeleteGlobalRef(env, previous);
    }
    return 0;
}


static int add_extra_import_paths(JNIEnv *env, jobjectArray paths) {
    PyObject *sys_path = PySys_GetObject("path");  /* borrowed */
    if (sys_path == NULL || !PyList_Check(sys_path)) {
        PyErr_SetString(PyExc_RuntimeError, "sys.path is unavailable");
        return -1;
    }
    jsize count = paths != NULL ? (*env)->GetArrayLength(env, paths) : 0;
    /*
     * Keep CPython's standard-library paths authoritative. Appending in Java
     * list order also preserves bundled PythonA packages before authenticated
     * Runtime Packs, and authenticated packs before unsigned pure wheels.
     */
    for (jsize index = 0; index < count; index++) {
        jstring item = (jstring)(*env)->GetObjectArrayElement(env, paths, index);
        if (item == NULL) {
            PyErr_SetString(PyExc_ValueError, "extra import path is null");
            return -1;
        }
        char *utf8 = jstring_to_utf8(env, item);
        (*env)->DeleteLocalRef(env, item);
        if (utf8 == NULL) {
            PyErr_SetString(PyExc_MemoryError, "import path conversion failed");
            return -1;
        }
        PyObject *path = PyUnicode_DecodeUTF8(utf8, (Py_ssize_t)strlen(utf8), "strict");
        free(utf8);
        if (path == NULL) {
            return -1;
        }
        int contains = PySequence_Contains(sys_path, path);
        if (contains < 0 || (contains == 0 && PyList_Append(sys_path, path) != 0)) {
            Py_DECREF(path);
            return -1;
        }
        Py_DECREF(path);
    }
    return 0;
}


static int install_runtime_hooks(void) {
    PyObject *module = PyImport_ImportModule("pythona_runtime_host");
    if (module == NULL) {
        return -1;
    }
    PyObject *result = PyObject_CallMethod(module, "install", NULL);
    Py_DECREF(module);
    if (result == NULL) {
        return -1;
    }
    Py_DECREF(result);
    return 0;
}


JNIEXPORT void JNICALL
Java_com_pythona_app_PythonEngine_nativeInitialize(
    JNIEnv *env,
    jobject owner,
    jstring home_value,
    jstring temporary_directory_value,
    jobjectArray extra_import_paths
) {
    char *home = jstring_to_utf8(env, home_value);
    char *temporary_directory = jstring_to_utf8(env, temporary_directory_value);
    if (home == NULL || temporary_directory == NULL) {
        free(home);
        free(temporary_directory);
        return;
    }
    if (attach_callbacks(env, owner) != 0) {
        free(home);
        free(temporary_directory);
        if (!(*env)->ExceptionCheck(env)) {
            throw_java(env, "java/lang/IllegalStateException", "Unable to attach Python callbacks");
        }
        return;
    }

    pthread_mutex_lock(&g_state_mutex);
    if (g_initialized) {
        bool same_home = g_python_home != NULL && strcmp(g_python_home, home) == 0;
        pthread_mutex_unlock(&g_state_mutex);
        if (!same_home) {
            throw_java(env, "java/lang/IllegalStateException", "CPython is already initialized with another home");
            free(home);
            free(temporary_directory);
            return;
        }
        PyGILState_STATE state = PyGILState_Ensure();
        if (add_extra_import_paths(env, extra_import_paths) != 0) {
            throw_python_exception(env);
        }
        PyGILState_Release(state);
        free(home);
        free(temporary_directory);
        return;
    }

    setenv("TMPDIR", temporary_directory, 1);
    setenv("PYTHONDONTWRITEBYTECODE", "1", 1);
    if (PyImport_AppendInittab("_pythona_native", PyInit__pythona_native) != 0) {
        pthread_mutex_unlock(&g_state_mutex);
        free(home);
        free(temporary_directory);
        throw_java(env, "java/lang/IllegalStateException", "Unable to register PythonA built-in module");
        return;
    }

    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    config.install_signal_handlers = 0;
    config.parse_argv = 0;
    config.user_site_directory = 0;
    config.site_import = 0; /* Only Java-selected service import paths. */
    config.write_bytecode = 0;
    char *argv[] = {""};
    PyStatus status = PyConfig_SetBytesArgv(&config, 1, argv);
    if (!PyStatus_Exception(status)) {
        status = PyConfig_SetBytesString(&config, &config.home, home);
    }
    if (!PyStatus_Exception(status)) {
        status = Py_InitializeFromConfig(&config);
    }
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) {
        pthread_mutex_unlock(&g_state_mutex);
        throw_java(
            env,
            "java/lang/IllegalStateException",
            status.err_msg != NULL ? status.err_msg : "CPython initialization failed");
        free(home);
        free(temporary_directory);
        return;
    }

    if (add_extra_import_paths(env, extra_import_paths) != 0
        || install_runtime_hooks() != 0) {
        throw_python_exception(env);
        Py_FinalizeEx();
        pthread_mutex_unlock(&g_state_mutex);
        free(home);
        free(temporary_directory);
        return;
    }
    g_python_home = home;
    g_main_thread_state = PyEval_SaveThread();
    g_initialized = true;
    pthread_mutex_unlock(&g_state_mutex);
    free(temporary_directory);
}


static PyObject *unicode_from_utf8(const char *value) {
    return PyUnicode_DecodeUTF8(value, (Py_ssize_t)strlen(value), "strict");
}


static PyObject *call_python_function(
    const char *module_name,
    const char *function_name,
    PyObject *arguments
) {
    PyObject *module = PyImport_ImportModule(module_name);
    if (module == NULL) {
        return NULL;
    }
    PyObject *function = PyObject_GetAttrString(module, function_name);
    Py_DECREF(module);
    if (function == NULL) {
        return NULL;
    }
    PyObject *result = PyObject_CallObject(function, arguments);
    Py_DECREF(function);
    return result;
}


static bool begin_run(const char *run_id, unsigned long python_thread_id) {
    bool started = false;
    pthread_mutex_lock(&g_input_mutex);
    if (g_active_run_id == NULL) {
        clear_input_queue_locked();
        g_active_run_id = duplicate_string(run_id);
        if (g_active_run_id != NULL) {
            atomic_store_explicit(&g_run_cancelled, false, memory_order_release);
            /* Publish the runner together with the active id. nativeStop uses
             * the same mutex, so it can never observe an active run with a
             * zero thread id and lose its one KeyboardInterrupt injection. */
            atomic_store_explicit(
                &g_active_python_thread,
                python_thread_id,
                memory_order_release);
            started = true;
        }
    }
    pthread_mutex_unlock(&g_input_mutex);
    return started;
}


static bool finish_run(void) {
    pthread_mutex_lock(&g_input_mutex);
    bool cancelled = atomic_load_explicit(&g_run_cancelled, memory_order_acquire);
    atomic_store_explicit(&g_active_python_thread, 0, memory_order_release);
    free(g_active_run_id);
    g_active_run_id = NULL;
    clear_input_queue_locked();
    pthread_cond_broadcast(&g_input_condition);
    pthread_mutex_unlock(&g_input_mutex);
    return cancelled;
}


typedef struct {
    char *run_id;
} InterruptTask;


/* PyErr_SetInterrupt is serviced only by the interpreter's main thread, but
 * RuntimeHostService may initialize CPython on its request worker and execute
 * scripts on another thread. Inject KeyboardInterrupt into the actual runner
 * after acquiring the GIL on a detached helper. Pure Python releases the GIL
 * frequently; a native extension which holds it forever still requires the
 * documented :runtime process restart fallback. */
static void *interrupt_run_thread(void *argument) {
    InterruptTask *task = argument;
    PyGILState_STATE state = PyGILState_Ensure();
    pthread_mutex_lock(&g_input_mutex);
    bool still_active = g_active_run_id != NULL
        && strcmp(g_active_run_id, task->run_id) == 0
        && atomic_load_explicit(&g_run_cancelled, memory_order_acquire);
    unsigned long thread_id = atomic_load_explicit(
        &g_active_python_thread, memory_order_acquire);
    pthread_mutex_unlock(&g_input_mutex);
    if (still_active && thread_id != 0) {
        int changed = PyThreadState_SetAsyncExc(thread_id, PyExc_KeyboardInterrupt);
        if (changed > 1) {
            /* This should be impossible for a thread identifier. Roll back
             * rather than leaving exceptions pending in unrelated threads. */
            PyThreadState_SetAsyncExc(thread_id, NULL);
        }
    }
    PyGILState_Release(state);
    free(task->run_id);
    free(task);
    return NULL;
}


static bool schedule_keyboard_interrupt(const char *run_id) {
    InterruptTask *task = calloc(1, sizeof(*task));
    if (task == NULL) {
        return false;
    }
    task->run_id = duplicate_string(run_id);
    if (task->run_id == NULL) {
        free(task);
        return false;
    }
    pthread_attr_t attributes;
    if (pthread_attr_init(&attributes) != 0) {
        free(task->run_id);
        free(task);
        return false;
    }
    pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_t thread;
    int status = pthread_create(&thread, &attributes, interrupt_run_thread, task);
    pthread_attr_destroy(&attributes);
    if (status != 0) {
        free(task->run_id);
        free(task);
        return false;
    }
    return true;
}


JNIEXPORT jstring JNICALL
Java_com_pythona_app_PythonEngine_nativeRunFile(
    JNIEnv *env,
    jobject owner,
    jstring run_id_value,
    jstring workspace_root_value,
    jstring script_path_value,
    jstring arguments_json_value
) {
    (void)owner;
    char *run_id = jstring_to_utf8(env, run_id_value);
    char *workspace_root = jstring_to_utf8(env, workspace_root_value);
    char *script_path = jstring_to_utf8(env, script_path_value);
    char *arguments_json = jstring_to_utf8(env, arguments_json_value);
    if (run_id == NULL || workspace_root == NULL || script_path == NULL || arguments_json == NULL) {
        free(run_id);
        free(workspace_root);
        free(script_path);
        free(arguments_json);
        return NULL;
    }
    PyGILState_STATE state = PyGILState_Ensure();
    if (!begin_run(run_id, PyThread_get_thread_ident())) {
        PyGILState_Release(state);
        throw_java(env, "java/lang/IllegalStateException", "Another Python run is active");
        free(run_id);
        free(workspace_root);
        free(script_path);
        free(arguments_json);
        return NULL;
    }

    PyObject *arguments = PyTuple_New(4);
    if (arguments != NULL) {
        PyTuple_SET_ITEM(arguments, 0, unicode_from_utf8(run_id));
        PyTuple_SET_ITEM(arguments, 1, unicode_from_utf8(workspace_root));
        PyTuple_SET_ITEM(arguments, 2, unicode_from_utf8(script_path));
        PyTuple_SET_ITEM(arguments, 3, unicode_from_utf8(arguments_json));
        for (Py_ssize_t index = 0; index < 4; index++) {
            if (PyTuple_GET_ITEM(arguments, index) == NULL) {
                Py_CLEAR(arguments);
                break;
            }
        }
    }
    PyObject *result = arguments != NULL
        ? call_python_function("pythona_runtime_host", "run_file", arguments)
        : NULL;
    Py_XDECREF(arguments);

    bool cancelled = finish_run();
    if (cancelled) {
        /* Consume an interrupt which raced with the Python-level handler after
         * run_file returned, otherwise it would poison the next request. */
        if (PyErr_CheckSignals() != 0) {
            PyErr_Clear();
        }
    }
    jstring java_result = NULL;
    if (result == NULL) {
        throw_python_exception(env);
    } else {
        java_result = python_unicode_to_jstring(env, result);
        Py_DECREF(result);
        if (java_result == NULL && PyErr_Occurred()) {
            throw_python_exception(env);
        }
    }
    PyGILState_Release(state);

    free(run_id);
    free(workspace_root);
    free(script_path);
    free(arguments_json);
    return java_result;
}


JNIEXPORT jstring JNICALL
Java_com_pythona_app_PythonEngine_nativeCallJson(
    JNIEnv *env,
    jobject owner,
    jstring request_json_value
) {
    (void)owner;
    char *request_json = jstring_to_utf8(env, request_json_value);
    if (request_json == NULL) {
        return NULL;
    }
    PyGILState_STATE state = PyGILState_Ensure();
    PyObject *request = unicode_from_utf8(request_json);
    PyObject *arguments = request != NULL ? PyTuple_Pack(1, request) : NULL;
    Py_XDECREF(request);
    PyObject *result = arguments != NULL
        ? call_python_function("pythona_jedi_host", "dispatch", arguments)
        : NULL;
    Py_XDECREF(arguments);

    jstring java_result = NULL;
    if (result == NULL) {
        throw_python_exception(env);
    } else {
        java_result = python_unicode_to_jstring(env, result);
        Py_DECREF(result);
        if (java_result == NULL && PyErr_Occurred()) {
            throw_python_exception(env);
        }
    }
    PyGILState_Release(state);
    free(request_json);
    return java_result;
}


/* Tests have their own host entry, but share the same native run identity,
 * console queue and interruption machinery as runFile. Empty id is a probe. */
JNIEXPORT jstring JNICALL
Java_com_pythona_app_PythonEngine_nativeTestJson(
    JNIEnv *env, jobject owner, jstring run_id_value, jstring request_json_value
) {
    (void)owner;
    char *run_id = jstring_to_utf8(env, run_id_value);
    char *request_json = jstring_to_utf8(env, request_json_value);
    if (run_id == NULL || request_json == NULL) {
        free(run_id); free(request_json);
        return NULL;
    }
    PyGILState_STATE state = PyGILState_Ensure();
    bool running = run_id[0] != '\0';
    if (running && !begin_run(run_id, PyThread_get_thread_ident())) {
        PyGILState_Release(state);
        free(run_id); free(request_json);
        throw_java(env, "java/lang/IllegalStateException", "Another Python run is active");
        return NULL;
    }
    PyObject *request = unicode_from_utf8(request_json);
    PyObject *arguments = request != NULL ? PyTuple_Pack(1, request) : NULL;
    Py_XDECREF(request);
    PyObject *result = arguments != NULL
        ? call_python_function("pythona_test_host", "dispatch", arguments) : NULL;
    Py_XDECREF(arguments);
    if (running) {
        bool cancelled = finish_run();
        if (cancelled && result != NULL && PyErr_CheckSignals() != 0) PyErr_Clear();
        /* An async interrupt must not poison a later task on this worker. */
        PyThreadState_SetAsyncExc(PyThread_get_thread_ident(), NULL);
    }
    jstring java_result = NULL;
    if (result == NULL) throw_python_exception(env);
    else {
        java_result = python_unicode_to_jstring(env, result);
        Py_DECREF(result);
        if (java_result == NULL && PyErr_Occurred()) throw_python_exception(env);
    }
    PyGILState_Release(state);
    free(run_id); free(request_json);
    return java_result;
}
JNIEXPORT jboolean JNICALL
Java_com_pythona_app_PythonEngine_nativeSendInput(
    JNIEnv *env,
    jobject owner,
    jstring run_id_value,
    jstring text_value
) {
    (void)owner;
    char *run_id = jstring_to_utf8(env, run_id_value);
    char *text = jstring_to_utf8(env, text_value);
    if (run_id == NULL || text == NULL) {
        free(run_id);
        free(text);
        return JNI_FALSE;
    }
    InputNode *node = calloc(1, sizeof(*node));
    if (node == NULL) {
        free(run_id);
        free(text);
        throw_java(env, "java/lang/OutOfMemoryError", "input queue allocation failed");
        return JNI_FALSE;
    }
    node->text = text;

    bool accepted = false;
    pthread_mutex_lock(&g_input_mutex);
    if (g_active_run_id != NULL
        && strcmp(g_active_run_id, run_id) == 0
        && !atomic_load_explicit(&g_run_cancelled, memory_order_acquire)) {
        if (g_input_tail == NULL) {
            g_input_head = node;
        } else {
            g_input_tail->next = node;
        }
        g_input_tail = node;
        pthread_cond_signal(&g_input_condition);
        accepted = true;
    }
    pthread_mutex_unlock(&g_input_mutex);
    if (!accepted) {
        free(node->text);
        free(node);
    }
    free(run_id);
    return accepted ? JNI_TRUE : JNI_FALSE;
}


JNIEXPORT jboolean JNICALL
Java_com_pythona_app_PythonEngine_nativeStop(
    JNIEnv *env,
    jobject owner,
    jstring run_id_value
) {
    (void)owner;
    char *run_id = jstring_to_utf8(env, run_id_value);
    if (run_id == NULL) {
        return JNI_FALSE;
    }
    bool accepted = false;
    pthread_mutex_lock(&g_input_mutex);
    if (g_active_run_id != NULL && strcmp(g_active_run_id, run_id) == 0) {
        atomic_store_explicit(&g_run_cancelled, true, memory_order_release);
        pthread_cond_broadcast(&g_input_condition);
        accepted = true;
    }
    pthread_mutex_unlock(&g_input_mutex);
    if (accepted) {
        if (!schedule_keyboard_interrupt(run_id)) {
            /* Best-effort fallback when a helper thread cannot be allocated. */
            PyErr_SetInterrupt();
        }
    }
    free(run_id);
    return accepted ? JNI_TRUE : JNI_FALSE;
}


JNIEXPORT void JNICALL
Java_com_pythona_app_PythonEngine_nativeCancelRequest(
    JNIEnv *env,
    jobject owner,
    jstring request_id_value
) {
    (void)owner;
    char *request_id = jstring_to_utf8(env, request_id_value);
    if (request_id != NULL) {
        cancel_request(request_id);
        free(request_id);
    }
}


JNIEXPORT void JNICALL
Java_com_pythona_app_PythonEngine_nativeDetachCallbacks(JNIEnv *env, jobject owner) {
    (void)owner;
    pthread_mutex_lock(&g_callback_mutex);
    jobject previous = g_callback;
    g_callback = NULL;
    g_output_method = NULL;
    g_input_method = NULL;
    pthread_mutex_unlock(&g_callback_mutex);
    if (previous != NULL) {
        (*env)->DeleteGlobalRef(env, previous);
    }
}


JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    g_vm = vm;
    return JNI_VERSION_1_6;
}
