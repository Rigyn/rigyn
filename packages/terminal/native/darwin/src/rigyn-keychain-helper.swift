import CoreFoundation
import Darwin
import Foundation
import Security

let MAX_REQUEST_BYTES = 1_048_576
let MAX_NAME_BYTES = 4_096

enum HelperFailure: Error {
  case invalidRequest
  case keychain(OSStatus)
}

struct Request {
  let operation: String
  let service: String
  let account: String
  let secret: String?
}

func wipe(_ data: inout Data) {
  guard !data.isEmpty else { return }
  data.resetBytes(in: 0..<data.count)
}

func readRequest() throws -> Data {
  var input = Data()
  while true {
    let remaining = MAX_REQUEST_BYTES - input.count
    let chunk = try FileHandle.standardInput.read(upToCount: min(65_536, remaining + 1)) ?? Data()
    if chunk.isEmpty { break }
    if chunk.count > remaining { throw HelperFailure.invalidRequest }
    input.append(chunk)
  }
  if input.isEmpty { throw HelperFailure.invalidRequest }
  return input
}

func requiredString(_ object: [String: Any], _ key: String, maximumBytes: Int) throws -> String {
  guard let value = object[key] as? String,
        !value.isEmpty,
        !value.contains("\0"),
        value.utf8.count <= maximumBytes else {
    throw HelperFailure.invalidRequest
  }
  return value
}

func parseRequest(_ data: Data) throws -> Request {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let version = object["version"] as? NSNumber,
        CFGetTypeID(version) != CFBooleanGetTypeID(),
        version.intValue == 1,
        version.doubleValue == 1,
        let operation = object["operation"] as? String else {
    throw HelperFailure.invalidRequest
  }
  let common = Set(["version", "operation", "service", "account"])
  let expected = operation == "set" ? common.union(["secret"]) : common
  guard (operation == "get" || operation == "set" || operation == "delete"),
        Set(object.keys) == expected else {
    throw HelperFailure.invalidRequest
  }
  return Request(
    operation: operation,
    service: try requiredString(object, "service", maximumBytes: MAX_NAME_BYTES),
    account: try requiredString(object, "account", maximumBytes: MAX_NAME_BYTES),
    secret: operation == "set"
      ? try requiredString(object, "secret", maximumBytes: MAX_REQUEST_BYTES)
      : nil
  )
}

func writeResponse(status: String, secret: String? = nil) throws {
  var response: [String: Any] = ["version": 1, "status": status]
  if let secret { response["secret"] = secret }
  var bytes = try JSONSerialization.data(withJSONObject: response)
  if bytes.count + 1 > MAX_REQUEST_BYTES { throw HelperFailure.invalidRequest }
  bytes.append(0x0a)
  FileHandle.standardOutput.write(bytes)
  wipe(&bytes)
}

func query(service: String, account: String) -> [CFString: Any] {
  return [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: account,
  ]
}

func get(_ request: Request) throws {
  var attributes = query(service: request.service, account: request.account)
  attributes[kSecReturnData] = true
  attributes[kSecMatchLimit] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(attributes as CFDictionary, &result)
  if status == errSecItemNotFound {
    try writeResponse(status: "not_found")
    return
  }
  guard status == errSecSuccess, var secretData = result as? Data else {
    throw HelperFailure.keychain(status)
  }
  defer { wipe(&secretData) }
  guard let secret = String(data: secretData, encoding: .utf8), !secret.isEmpty else {
    throw HelperFailure.invalidRequest
  }
  try writeResponse(status: "ok", secret: secret)
}

func set(_ request: Request) throws {
  guard let secret = request.secret else { throw HelperFailure.invalidRequest }
  var secretData = Data(secret.utf8)
  defer { wipe(&secretData) }
  let attributes = query(service: request.service, account: request.account)
  let replacement: [CFString: Any] = [kSecValueData: secretData]
  var status = SecItemUpdate(attributes as CFDictionary, replacement as CFDictionary)
  if status == errSecItemNotFound {
    var addition = attributes
    addition[kSecValueData] = secretData
    status = SecItemAdd(addition as CFDictionary, nil)
    if status == errSecDuplicateItem {
      status = SecItemUpdate(attributes as CFDictionary, replacement as CFDictionary)
    }
  }
  guard status == errSecSuccess else { throw HelperFailure.keychain(status) }
  try writeResponse(status: "ok")
}

func delete(_ request: Request) throws {
  let status = SecItemDelete(query(service: request.service, account: request.account) as CFDictionary)
  if status == errSecItemNotFound {
    try writeResponse(status: "not_found")
    return
  }
  guard status == errSecSuccess else { throw HelperFailure.keychain(status) }
  try writeResponse(status: "ok")
}

func run() throws {
  guard CommandLine.arguments.count == 1 else { throw HelperFailure.invalidRequest }
  var input = try readRequest()
  defer { wipe(&input) }
  let request = try parseRequest(input)
  switch request.operation {
  case "get": try get(request)
  case "set": try set(request)
  case "delete": try delete(request)
  default: throw HelperFailure.invalidRequest
  }
}

do {
  try run()
} catch {
  FileHandle.standardError.write(Data("rigyn-keychain-helper: request failed\n".utf8))
  Darwin.exit(1)
}
