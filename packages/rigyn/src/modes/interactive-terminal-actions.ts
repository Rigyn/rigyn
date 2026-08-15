import type { SettingsManager } from "../core/settings-manager.js";
import { readClipboardImage } from "../images/clipboard.js";
import { readClipboardText } from "../images/clipboard-text.js";
import { preprocessImage } from "../images/preprocess.js";
import type { TuiController } from "../tui/controller.js";

interface ClipboardActionDependencies {
  readClipboardImage?: typeof readClipboardImage;
  readClipboardText?: typeof readClipboardText;
}

/** Attaches a clipboard image, or inserts clipboard text when no image is available. */
export async function attachClipboardImage(
  terminal: Pick<TuiController, "attachInputImage" | "insertClipboardText" | "notify" | "setInputBlocked">,
  settings: Pick<SettingsManager, "getBlockImages" | "getImageAutoResize">,
  signal?: AbortSignal,
  dependencies: ClipboardActionDependencies = {},
): Promise<boolean> {
  signal?.throwIfAborted();
  terminal.setInputBlocked("Reading clipboard…", "clipboard");
  try {
    const imagesBlocked = settings.getBlockImages();
    const imageResult = imagesBlocked
      ? undefined
      : await (dependencies.readClipboardImage ?? readClipboardImage)(
          signal === undefined ? {} : { signal },
        );
    signal?.throwIfAborted();
    if (imageResult?.image !== undefined) {
      const image = await preprocessImage(imageResult.image.bytes, {
        autoResize: settings.getImageAutoResize(),
        ...(signal === undefined ? {} : { signal }),
      });
      terminal.attachInputImage({
        block: {
          type: "image",
          mediaType: image.mediaType,
          data: Buffer.from(image.bytes).toString("base64"),
        },
        label: "clipboard",
        coordinates: { ...image.coordinates },
      });
      terminal.notify("Attached clipboard image");
      return true;
    }

    const textResult = await (dependencies.readClipboardText ?? readClipboardText)(
      signal === undefined ? {} : { signal },
    );
    signal?.throwIfAborted();
    if (textResult.text !== undefined && textResult.text !== "") {
      terminal.insertClipboardText(textResult.text);
      return true;
    }

    terminal.notify(
      imagesBlocked
        ? "Image inputs are disabled in settings"
        : imageResult?.diagnostics.at(-1)?.detail ?? "The clipboard does not contain supported text or an image",
      "warning",
    );
    return false;
  } finally {
    terminal.setInputBlocked();
  }
}
