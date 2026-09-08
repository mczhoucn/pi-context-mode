/** The supported Pi loader supplies this module (including for compiled JS).
 * Deliberately not an npm dependency: never ship a second copy of the host.
 */
declare module "@earendil-works/pi-coding-agent" {
  export const createReadToolDefinition: import("./tool-replacements.js").NativeToolSDK["createReadToolDefinition"];
  export const createBashToolDefinition: import("./tool-replacements.js").NativeToolSDK["createBashToolDefinition"];
  export const detectSupportedImageMimeTypeFromFile: import("./tool-replacements.js").NativeToolSDK["detectSupportedImageMimeTypeFromFile"];
  export const truncateHead: import("./tool-replacements.js").NativeToolSDK["truncateHead"];
}
