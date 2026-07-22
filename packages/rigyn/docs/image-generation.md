# Image generation

`rigyn/images` is the independent image-generation API. It is separate from the chat provider registry and from the clipboard/preprocessing helpers used to attach images to coding-agent prompts. Selecting a chat model never silently selects an image model, and adding an image provider never changes the agent loop.

The built-in image provider is OpenRouter. Its catalog is committed with the package so discovery is synchronous and works offline; `npm run generate:image-models --workspace rigyn` refreshes that catalog from OpenRouter for a future release. The generated catalog contains only models whose declared output includes images.

## One-shot generation

Set `OPENROUTER_API_KEY`, select a model, and inspect the returned result:

```js
import { generateImages, getImageModel } from "rigyn/images";

const model = getImageModel("openrouter", "google/gemini-2.5-flash-image");
if (!model) throw new Error("The selected image model is not in this release's catalog");

const result = await generateImages(model, {
  input: [{ type: "text", text: "A small red sailboat on a calm lake" }],
}, {
  apiKey: process.env.OPENROUTER_API_KEY,
});

if (result.stopReason !== "stop") {
  throw new Error(result.errorMessage);
}

for (const item of result.output) {
  if (item.type === "text") console.log(item.text);
  else console.log(item.mimeType, item.data.length);
}
```

`generateImages()` always resolves. Authentication, validation, transport, provider, hook, and response failures are represented by `stopReason: "error"` or `"aborted"`, an empty output array, and a bounded `errorMessage`. This makes a one-shot call safe to use in a tool or extension without an unhandled provider rejection.

Image inputs and outputs are base64 data with an explicit `image/*` MIME type. Inputs are validated with the same 8 MiB per-image boundary used by the rest of Rigyn. Remote image URLs are not accepted as generation inputs, and remote or malformed provider image outputs are ignored. Text is normalized before JSON encoding so an unpaired UTF-16 surrogate cannot make a provider request invalid.

When a provider reports usage, Rigyn returns mutually exclusive input, cache-read, cache-write, and output counters. Cost components are included only when the selected catalog row has usable non-negative per-million-token prices; unknown pricing stays unknown.

## Provider collection and credentials

Use `builtinImagesModels()` when an application wants provider discovery, mutable registration, resolved credentials, or dynamic catalog refresh:

```js
import { builtinImagesModels } from "rigyn/images";

const images = builtinImagesModels();
const models = images.getModels("openrouter");
const model = models[0];
if (!model) throw new Error("No OpenRouter image model is available");
const result = await images.generateImages(model, {
  input: [{ type: "text", text: "A minimal geometric icon" }],
});
```

The default collection reads `OPENROUTER_API_KEY` through the same provider-auth contract as text models. `createImagesModels({ credentials, authContext })` accepts the same credential store and environment/file context as `createModels()`, including serialized OAuth refresh. Resolved authentication may select an API key, request headers, a base URL, and provider-scoped environment values. Per-call fields win over resolved fields. `credentialBroker` and `environment` remain compatibility inputs for older embedding hosts.

The mutable collection supports `setProvider()`, `deleteProvider()`, `clearProviders()`, synchronous last-known model reads, and `refresh()`. Dynamic providers share concurrent refresh work. A failed refresh preserves the last successful catalog and a later call retries. Refreshing one named provider reports its error; refreshing all providers is best-effort.

## Custom image APIs

An image API implementation and its user-facing provider are separate concerns:

```js
import {
  createImagesProvider,
  createImagesModels,
  generateImages,
  registerImagesApiProvider,
} from "rigyn/images";
import { companyGenerateImages, companyModel } from "./company-images.js";

registerImagesApiProvider({
  api: "company-images",
  generateImages: companyGenerateImages,
});

// One-shot calls dispatch through the API registry by companyModel.api.
const oneShot = await generateImages(companyModel, {
  input: [{ type: "text", text: "A minimal geometric icon" }],
});
console.log(oneShot.stopReason);

const provider = createImagesProvider({
  id: "company",
  auth: {
    apiKey: {
      name: "Company Images key",
      async resolve({ ctx, credential }) {
        const apiKey = credential?.key ?? await ctx.env("COMPANY_IMAGES_KEY");
        return apiKey ? { auth: { apiKey }, source: credential ? "stored credential" : "COMPANY_IMAGES_KEY" } : undefined;
      },
    },
  },
  models: [companyModel],
  api: { generateImages: companyGenerateImages },
});

// The default auth context reads process environment and the default credential
// store; embedding hosts can instead pass their own { credentials, authContext }.
const collection = createImagesModels();
collection.setProvider(provider);
```

The explicit API registry dispatches one-shot calls by `model.api` and rejects an API/model mismatch before a request is sent. Provider collections dispatch by `model.provider`, resolve credentials, and then invoke the provider. Registrations can be replaced or removed by an owning application; built-ins are restored lazily when a built-in one-shot call needs them.

## Request controls

`ImagesOptions` supports cancellation, per-call credentials and environment values, header overrides or suppression, a timeout, bounded retries, a maximum server-requested retry delay, a response-size limit, and async payload/response hooks.

- SDK retries are disabled. Rigyn owns the retry loop so attempts, cancellation, and delay caps are deterministic.
- `maxRetries` accepts 0 through 10 and defaults to 0.
- `maxRetryDelayMs` defaults to 60 seconds; 0 disables only this server-delay cap.
- `timeoutMs` is bounded at ten minutes.
- `maxResponseBytes` defaults to 64 MiB and is capped at 256 MiB.
- The payload hook receives a request-local payload. The selected payload is then detached and Unicode-sanitized through a JSON boundary; a replacement must remain a JSON object within the request-size limit.
- The response hook receives status and response headers for each observable HTTP attempt. Authentication remains owned by the SDK and credential broker; a custom `Authorization` header is discarded.

OpenRouter is loaded through the exact-pinned OpenAI client only when the first image request is made. Rigyn supplies the endpoint, fetch implementation, credential, zero-SDK-retry policy, bounds, and result normalization; the SDK is a transport dependency rather than the image subsystem's architecture.
