import type { ImageBlock } from "../core/types.js";
import {
  ImageSourceValidationError,
  validateImageSource,
  type NormalizedImageSource,
} from "../core/image-source.js";
import { InvalidProviderRequestError } from "./transport.js";

export {
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_IMAGE_MEDIA_TYPE_LENGTH,
  MAX_IMAGE_URL_LENGTH,
  type NormalizedImageSource,
} from "../core/image-source.js";

export function normalizeImageSource(block: ImageBlock, provider: string): NormalizedImageSource {
  try {
    return validateImageSource(block);
  } catch (error) {
    if (error instanceof ImageSourceValidationError) throw invalid(provider, error.message);
    throw error;
  }
}

export function requireImageMediaType(
  source: NormalizedImageSource,
  provider: string,
  supported: readonly string[],
): void {
  if (!supported.includes(source.mediaType)) {
    throw invalid(provider, `does not support ${source.mediaType}; expected ${supported.join(", ")}`);
  }
}

export function requireImageUrlProtocol(
  source: NormalizedImageSource,
  provider: string,
  protocols: readonly string[],
): void {
  if (source.kind !== "url") return;
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    throw invalid(provider, "URL must be fully qualified");
  }
  if (!protocols.includes(parsed.protocol)) {
    throw invalid(provider, `URL must use ${protocols.join(" or ")}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalid(provider, "URL must not contain credentials");
  }
}

export function unsupportedImageUrl(provider: string, url: string): never {
  let scheme = "URL";
  try {
    scheme = `${new URL(url).protocol} URL`;
  } catch {
    // The provider-specific error remains more useful than a URL parser error.
  }
  throw invalid(provider, `does not support ${scheme} image input; use base64 data`);
}

function invalid(provider: string, detail: string): InvalidProviderRequestError {
  return new InvalidProviderRequestError(`${provider} image input ${detail}`);
}
