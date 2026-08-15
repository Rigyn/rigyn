#include <stdbool.h>
#include <stddef.h>
#include <windows.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value(__cdecl *napi_callback)(napi_env env,
                                           napi_callback_info info);
typedef napi_status(__cdecl *napi_create_function_fn)(
    napi_env env, const char *name, size_t length, napi_callback callback,
    void *data, napi_value *result);
typedef napi_status(__cdecl *napi_get_boolean_fn)(napi_env env, bool value,
                                                  napi_value *result);
typedef napi_status(__cdecl *napi_set_named_property_fn)(
    napi_env env, napi_value object, const char *name, napi_value value);

static napi_get_boolean_fn napi_get_boolean_ptr;

static napi_value __cdecl enable_virtual_terminal_input(
    napi_env env, napi_callback_info info) {
  DWORD mode = 0;
  bool was_enabled = false;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  (void)info;

  if (input != NULL && input != INVALID_HANDLE_VALUE &&
      GetConsoleMode(input, &mode)) {
    was_enabled = (mode & ENABLE_VIRTUAL_TERMINAL_INPUT) != 0;
    if (!was_enabled) {
      SetConsoleMode(input, mode | ENABLE_VIRTUAL_TERMINAL_INPUT);
    }
  }

  napi_value result;
  return napi_get_boolean_ptr(env, was_enabled, &result) == 0 ? result : NULL;
}

__declspec(dllexport) napi_value __cdecl napi_register_module_v1(
    napi_env env, napi_value exports) {
  HMODULE node = GetModuleHandleW(NULL);
  if (node == NULL) {
    return NULL;
  }

  napi_create_function_fn create_function =
      (napi_create_function_fn)GetProcAddress(node, "napi_create_function");
  napi_set_named_property_fn set_named_property =
      (napi_set_named_property_fn)GetProcAddress(node,
                                                 "napi_set_named_property");
  napi_get_boolean_ptr =
      (napi_get_boolean_fn)GetProcAddress(node, "napi_get_boolean");
  if (create_function == NULL || set_named_property == NULL ||
      napi_get_boolean_ptr == NULL) {
    return NULL;
  }

  napi_value function;
  if (create_function(env, "enableVirtualTerminalInput",
                      sizeof("enableVirtualTerminalInput") - 1,
                      enable_virtual_terminal_input, NULL, &function) != 0) {
    return NULL;
  }
  if (set_named_property(env, exports, "enableVirtualTerminalInput",
                         function) != 0) {
    return NULL;
  }
  return exports;
}
