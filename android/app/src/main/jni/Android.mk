LOCAL_PATH := $(call my-dir)

ifndef PYTHONA_PYTHON_PREFIX
$(error PYTHONA_PYTHON_PREFIX must point to the official CPython 3.14.7 Android prefix)
endif

include $(CLEAR_VARS)
LOCAL_MODULE := python314
LOCAL_SRC_FILES := $(PYTHONA_PYTHON_PREFIX)/lib/libpython3.14.so
include $(PREBUILT_SHARED_LIBRARY)

include $(CLEAR_VARS)
LOCAL_MODULE := pythona_engine
LOCAL_SRC_FILES := ../cpp/pythona_engine.c
LOCAL_C_INCLUDES := $(PYTHONA_PYTHON_PREFIX)/include/python3.14
LOCAL_SHARED_LIBRARIES := python314
LOCAL_LDLIBS := -llog -landroid -ldl -lm
LOCAL_CFLAGS := \
    -std=c11 \
    -Wall \
    -Wextra \
    -Werror=implicit-function-declaration \
    -fvisibility=hidden \
    -D__BIONIC_NO_PAGE_SIZE_MACRO
LOCAL_LDFLAGS := \
    -Wl,--build-id=sha1 \
    -Wl,--no-undefined \
    -Wl,--no-rosegment \
    -Wl,-z,max-page-size=16384
include $(BUILD_SHARED_LIBRARY)
