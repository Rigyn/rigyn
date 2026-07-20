import {
  createRigynSdk,
  type CreateRigynSdkOptions,
  type RigynSdk,
  type RigynSdkComposition,
  type RigynSdkExtensionFactory,
  type RigynSdkPromptTemplate,
  type RigynSdkResourceLoader,
  type RigynSdkRunOptions,
} from "rigyn/sdk";

const template = {
  id: "review",
  description: "Review a request",
  template: "Review: {{input}}",
} satisfies RigynSdkPromptTemplate;

const extensionFactory: RigynSdkExtensionFactory = ({ workspace, signal }) => {
  signal.throwIfAborted();
  return {
    templates: [template],
    context: {
      appendSystemPrompt: [{ text: `Workspace: ${workspace}`, source: "host" }],
    },
  } satisfies RigynSdkComposition;
};

const resourceLoader: RigynSdkResourceLoader = async ({ workspace }) => ({
  skillPaths: [`${workspace}/skills`],
  promptTemplatePaths: [`${workspace}/prompts`],
});

const options = {
  workspace: process.cwd(),
  extensions: { factories: [extensionFactory] },
  resources: { loaders: [resourceLoader] },
  defaultSelection: { provider: "host-provider", model: "host-model" },
  runtime: { recover: false, projectTrusted: false },
} satisfies CreateRigynSdkOptions;

const factory: (input?: CreateRigynSdkOptions) => Promise<RigynSdk> = createRigynSdk;
void [factory, options];

declare const sdk: RigynSdk;
const run = {
  prompt: sdk.renderPrompt("review", "changes"),
  maxSteps: 8,
} satisfies RigynSdkRunOptions;
void [run, sdk.promptTemplates(), sdk.resourceCatalog(), sdk.createSession()];
