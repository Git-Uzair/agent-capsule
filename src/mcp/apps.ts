import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import type { Manifest } from "../format/manifest.ts";
import type { CatalogResource } from "./catalog.ts";

export const UI_MIME_TYPE = "text/html;profile=mcp-app";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

export type UiResourceCsp = {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
};

export type UiResourceMeta = {
  ui: {
    csp: UiResourceCsp;
    prefersBorder: boolean;
  };
};

export type UiResourceContent = {
  uri: string;
  mimeType: string;
  text: string;
  _meta: UiResourceMeta;
};

/**
 * If the capsule manifest declares a ui.app, return its catalog resource descriptor.
 */
export function uiResourceDescriptor(manifest: Manifest): CatalogResource | undefined {
  if (manifest.ui?.app === undefined) {
    return undefined;
  }
  return {
    uri: manifest.ui.app.resourceUri,
    name: "App UI",
    mimeType: UI_MIME_TYPE,
  };
}

/**
 * Read the UI HTML entry from the capsule and return its MCP resource content with CSP metadata.
 */
export async function readUiResource(loaded: LoadedCapsule): Promise<UiResourceContent> {
  const app = loaded.manifest.ui?.app;
  if (app === undefined) {
    throw new CapsuleError("E_CONTAINER", "capsule does not declare a ui.app");
  }
  const bytes = await loaded.reader.read(app.path);
  return {
    uri: app.resourceUri,
    mimeType: UI_MIME_TYPE,
    text: bytes.toString("utf8"),
    _meta: {
      ui: {
        csp: {
          connectDomains: app.csp?.connectDomains ? [...app.csp.connectDomains] : [],
          resourceDomains: app.csp?.resourceDomains ? [...app.csp.resourceDomains] : [],
          frameDomains: app.csp?.frameDomains ? [...app.csp.frameDomains] : [],
          baseUriDomains: app.csp?.baseUriDomains ? [...app.csp.baseUriDomains] : [],
        },
        prefersBorder: false,
      },
    },
  };
}
