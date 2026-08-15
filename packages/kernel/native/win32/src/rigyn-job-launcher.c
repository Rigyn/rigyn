#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <io.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define RIGYN_LAUNCH_FAILURE 125

static void report_failure(void) {
  static const char message[] = "rigyn-job-launcher: launch failed\r\n";
  DWORD written = 0;
  HANDLE error_handle = GetStdHandle(STD_ERROR_HANDLE);
  if (error_handle != NULL && error_handle != INVALID_HANDLE_VALUE) {
    WriteFile(error_handle, message, (DWORD)(sizeof(message) - 1), &written, NULL);
  }
}

static void report_status(char status) {
  intptr_t value = _get_osfhandle(3);
  if (value != -1) {
    DWORD written = 0;
    WriteFile((HANDLE)value, &status, 1, &written, NULL);
    _close(3);
  }
}

static void close_valid_handle(HANDLE handle) {
  if (handle != NULL && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
}

static int duplicate_standard_handle(DWORD identifier, HANDLE *result) {
  HANDLE source = GetStdHandle(identifier);
  if (source == NULL || source == INVALID_HANDLE_VALUE) return 0;
  return DuplicateHandle(
    GetCurrentProcess(), source, GetCurrentProcess(), result, 0, TRUE, DUPLICATE_SAME_ACCESS
  ) != 0;
}

static int checked_add_size(size_t left, size_t right, size_t *result) {
  if (right > SIZE_MAX - left) return 0;
  *result = left + right;
  return 1;
}

static wchar_t *build_command_line(const wchar_t *shell, const wchar_t *command) {
  static const wchar_t switches[] = L" /d /s /c \"";
  const size_t shell_length = wcslen(shell);
  const size_t command_length = wcslen(command);
  size_t trailing_slashes = 0;
  size_t characters = 0;
  while (trailing_slashes < shell_length && shell[shell_length - trailing_slashes - 1] == L'\\') {
    trailing_slashes += 1;
  }
  if (!checked_add_size(shell_length, trailing_slashes, &characters)
      || !checked_add_size(characters, (sizeof(switches) / sizeof(switches[0])) - 1, &characters)
      || !checked_add_size(characters, command_length, &characters)
      || !checked_add_size(characters, 4, &characters)
      || characters > SIZE_MAX / sizeof(wchar_t)) return NULL;

  wchar_t *line = (wchar_t *)calloc(characters, sizeof(wchar_t));
  if (line == NULL) return NULL;
  wchar_t *cursor = line;
  *cursor++ = L'\"';
  if (shell_length > 0) {
    memcpy(cursor, shell, shell_length * sizeof(wchar_t));
    cursor += shell_length;
  }
  for (size_t index = 0; index < trailing_slashes; index += 1) *cursor++ = L'\\';
  *cursor++ = L'\"';
  memcpy(cursor, switches, (sizeof(switches) / sizeof(switches[0]) - 1) * sizeof(wchar_t));
  cursor += (sizeof(switches) / sizeof(switches[0])) - 1;
  if (command_length > 0) {
    memcpy(cursor, command, command_length * sizeof(wchar_t));
    cursor += command_length;
  }
  *cursor++ = L'\"';
  *cursor = L'\0';
  return line;
}

int wmain(int argc, wchar_t **argv) {
  HANDLE job = NULL;
  HANDLE standard_handles[3] = { NULL, NULL, NULL };
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  int attributes_initialized = 0;
  wchar_t *command_line = NULL;
  PROCESS_INFORMATION process = { 0 };
  int child_created = 0;
  DWORD child_exit_code = RIGYN_LAUNCH_FAILURE;
  int result = RIGYN_LAUNCH_FAILURE;
  int succeeded = 0;

  if (argc != 3 || argv[1][0] == L'\0' || wcschr(argv[1], L'\"') != NULL) goto cleanup;

  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) goto cleanup;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = { 0 };
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
        job, JobObjectExtendedLimitInformation, &limits, (DWORD)sizeof(limits)
      )) goto cleanup;

  if (!duplicate_standard_handle(STD_INPUT_HANDLE, &standard_handles[0])
      || !duplicate_standard_handle(STD_OUTPUT_HANDLE, &standard_handles[1])
      || !duplicate_standard_handle(STD_ERROR_HANDLE, &standard_handles[2])) goto cleanup;

  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &attribute_bytes);
  if (attribute_bytes == 0) goto cleanup;
  attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attribute_bytes);
  if (attributes == NULL || !InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_bytes)) goto cleanup;
  attributes_initialized = 1;
  if (!UpdateProcThreadAttribute(
        attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL
      )
      || !UpdateProcThreadAttribute(
        attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        standard_handles, sizeof(standard_handles), NULL, NULL
      )) goto cleanup;

  command_line = build_command_line(argv[1], argv[2]);
  if (command_line == NULL) goto cleanup;
  STARTUPINFOEXW startup = { 0 };
  startup.StartupInfo.cb = (DWORD)sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = standard_handles[0];
  startup.StartupInfo.hStdOutput = standard_handles[1];
  startup.StartupInfo.hStdError = standard_handles[2];
  startup.lpAttributeList = attributes;
  if (!CreateProcessW(
        NULL, command_line, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
        NULL, NULL, &startup.StartupInfo, &process
      )) goto cleanup;
  child_created = 1;
  close_valid_handle(process.hThread);
  process.hThread = NULL;
  for (size_t index = 0; index < 3; index += 1) {
    close_valid_handle(standard_handles[index]);
    standard_handles[index] = NULL;
  }

  if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0
      || !GetExitCodeProcess(process.hProcess, &child_exit_code)) goto cleanup;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = { 0 };
    if (!QueryInformationJobObject(
          job, JobObjectBasicAccountingInformation, &accounting, (DWORD)sizeof(accounting), NULL
        )) goto cleanup;
    if (accounting.ActiveProcesses == 0) break;
    Sleep(10);
  }
  result = (int)child_exit_code;
  succeeded = 1;

cleanup:
  if (!succeeded && child_created) {
    TerminateJobObject(job, RIGYN_LAUNCH_FAILURE);
  }
  close_valid_handle(process.hThread);
  close_valid_handle(process.hProcess);
  if (attributes != NULL) {
    if (attributes_initialized) DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
  }
  for (size_t index = 0; index < 3; index += 1) close_valid_handle(standard_handles[index]);
  free(command_line);
  close_valid_handle(job);
  report_status(succeeded ? 'O' : 'E');
  if (!succeeded) report_failure();
  return result;
}
