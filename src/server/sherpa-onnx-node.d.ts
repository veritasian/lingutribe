// sherpa-onnx-node ships no type declarations. We only use OfflineRecognizer,
// readWave, and createStream at runtime, so a permissive `any` module is fine.
declare module "sherpa-onnx-node";
