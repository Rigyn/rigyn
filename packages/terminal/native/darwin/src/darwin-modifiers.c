#include <node_api.h>
#include <ApplicationServices/ApplicationServices.h>
#include <string.h>

static napi_value ModifierPressed(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[32] = {0};
  size_t length = 0;
  if (argc == 1) napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &length);
  CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
  bool pressed = false;
  if (strcmp(name, "shift") == 0) pressed = (flags & kCGEventFlagMaskShift) != 0;
  else if (strcmp(name, "ctrl") == 0) pressed = (flags & kCGEventFlagMaskControl) != 0;
  else if (strcmp(name, "alt") == 0) pressed = (flags & kCGEventFlagMaskAlternate) != 0;
  else if (strcmp(name, "meta") == 0) pressed = (flags & kCGEventFlagMaskCommand) != 0;
  napi_value result;
  napi_get_boolean(env, pressed, &result);
  return result;
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "modifierPressed", NAPI_AUTO_LENGTH, ModifierPressed, NULL, &function);
  napi_set_named_property(env, exports, "modifierPressed", function);
  return exports;
}

NAPI_MODULE_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  return Initialize(env, exports);
}
