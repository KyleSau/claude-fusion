// Minimal stand-in for the `vscode` module, enough for the conversion code under test.
export class LanguageModelTextPart {
  constructor(public value: string) {}
}
export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
  static image(data: Uint8Array, mime: string) {
    return new LanguageModelDataPart(data, mime);
  }
  static json(value: unknown, mime = 'application/json') {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
  }
}
export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}
export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}
