# Face models for transform-gemini (Face Lock)

Place the following ONNX model files in this folder:

- **retinaface.onnx** – Face detector. Input: `(1, 3, 640, 640)` NCHW float32, BGR normalized (subtract [104, 117, 123]). Output: one face bbox `(x1, y1, x2, y2)` or compatible.
- **2d106det.onnx** – 106-point landmark model. Input: `(1, 3, 192, 192)` cropped face, float32. Output: `(1, 212)` → 106×(x,y) in [0,1] for the 192×192 crop.

Sources (examples): InsightFace model zoo, Hugging Face `LPDoctor/insightface` or `menglaoda/_insightface` (retinaface + 2d106det).

If either file is missing, the API falls back to returning the generated image without face lock.
