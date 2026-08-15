import type { AmbientCredentialDescriptor, AmbientProvider } from "./types.js";

function present(environment: NodeJS.ProcessEnv, name: string): boolean {
  return environment[name] !== undefined && environment[name] !== "";
}

export function describeAmbientIdentity(
  provider: AmbientProvider,
  environment: NodeJS.ProcessEnv = process.env,
): AmbientCredentialDescriptor {
  switch (provider) {
    case "aws":
      return {
        kind: "ambient",
        provider,
        mechanism: "aws_default_chain",
        hints: {
          profileConfigured: present(environment, "AWS_PROFILE"),
          webIdentityConfigured: present(environment, "AWS_WEB_IDENTITY_TOKEN_FILE"),
          containerCredentialsConfigured:
            present(environment, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
            present(environment, "AWS_CONTAINER_CREDENTIALS_FULL_URI"),
          staticEnvironmentCredentialsConfigured:
            present(environment, "AWS_ACCESS_KEY_ID") && present(environment, "AWS_SECRET_ACCESS_KEY"),
        },
      };
    case "google":
      return {
        kind: "ambient",
        provider,
        mechanism: "google_adc",
        hints: {
          credentialsFileConfigured: present(environment, "GOOGLE_APPLICATION_CREDENTIALS"),
          projectConfigured:
            present(environment, "GOOGLE_CLOUD_PROJECT") || present(environment, "GCLOUD_PROJECT"),
          metadataMayBeAvailable: true,
        },
      };
    case "azure":
      return {
        kind: "ambient",
        provider,
        mechanism: "azure_default_credential",
        hints: {
          servicePrincipalConfigured:
            present(environment, "AZURE_TENANT_ID") &&
            present(environment, "AZURE_CLIENT_ID") &&
            present(environment, "AZURE_CLIENT_SECRET"),
          certificateCredentialConfigured: present(environment, "AZURE_CLIENT_CERTIFICATE_PATH"),
          workloadIdentityConfigured:
            present(environment, "AZURE_TENANT_ID") &&
            present(environment, "AZURE_CLIENT_ID") &&
              present(environment, "AZURE_FEDERATED_TOKEN_FILE"),
          appServiceManagedIdentityConfigured:
            present(environment, "IDENTITY_ENDPOINT") && present(environment, "IDENTITY_HEADER"),
          managedIdentityMayBeAvailable: true,
        },
      };
  }
}
