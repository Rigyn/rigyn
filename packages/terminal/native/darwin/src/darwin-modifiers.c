#include <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_create_function(napi_env env, const char *name,
                                        size_t length, napi_callback callback,
                                        void *data, napi_value *result);
extern napi_status napi_get_boolean(napi_env env, bool value,
                                    napi_value *result);
extern napi_status napi_get_cb_info(napi_env env, napi_callback_info info,
                                    size_t *argc, napi_value *argv,
                                    napi_value *this_arg, void **data);
extern napi_status napi_get_value_string_utf8(napi_env env, napi_value value,
                                              char *buffer, size_t buffer_size,
                                              size_t *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object,
                                           const char *name, napi_value value);

static CGEventFlags modifier_mask(const char *name, size_t length) {
  if (length == 5 && memcmp(name, "shift", 5) == 0) {
    return kCGEventFlagMaskShift;
  }
  if (length == 7 && memcmp(name, "command", 7) == 0) {
    return kCGEventFlagMaskCommand;
  }
  if (length == 7 && memcmp(name, "control", 7) == 0) {
    return kCGEventFlagMaskControl;
  }
  if (length == 6 && memcmp(name, "option", 6) == 0) {
    return kCGEventFlagMaskAlternate;
  }
  return 0;
}

static napi_value is_modifier_pressed(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t argc = 1;
  size_t length = 0;
  bool pressed = false;

  if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) == 0 &&
      argc == 1 &&
      napi_get_value_string_utf8(env, argument, NULL, 0, &length) == 0 &&
      length <= 7) {
    char name[8];
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, argument, name, sizeof(name), &copied) ==
            0 &&
        copied == length) {
      CGEventFlags mask = modifier_mask(name, length);
      if (mask != 0) {
        CGEventFlags flags = CGEventSourceFlagsState(
            kCGEventSourceStateCombinedSessionState);
        pressed = (flags & mask) != 0;
      }
    }
  }

  napi_value result;
  return napi_get_boolean(env, pressed, &result) == 0 ? result : NULL;
}

__attribute__((visibility("default"))) napi_value
napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "isModifierPressed",
                           sizeof("isModifierPressed") - 1,
                           is_modifier_pressed, NULL, &function) != 0) {
    return NULL;
  }
  if (napi_set_named_property(env, exports, "isModifierPressed", function) !=
      0) {
    return NULL;
  }
  return exports;
}
