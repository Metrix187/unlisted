"""dump a reference dinov2-small cls embedding for the js port's parity test.

feeds a fixed 224x224 uint8 image straight in (no hf resize/crop) so both sides see identical pixels.
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import AutoModel

REV = "ed25f3a31f01632728cabb09d1542f84ab7b0056"
root = Path(__file__).resolve().parents[2]
src = root / "packages/vision/fixtures/kitchen.jpg"
out = root / "packages/vision/fixtures/dino-ref"
out.mkdir(exist_ok=True)

img = Image.open(src).convert("RGB").resize((224, 224), Image.BILINEAR)
arr = np.asarray(img, dtype=np.uint8)
(out / "kitchen-224.rgb").write_bytes(arr.tobytes())

model = AutoModel.from_pretrained("facebook/dinov2-small", revision=REV).eval()
x = torch.from_numpy(arr).float().div(255).permute(2, 0, 1)[None]
mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]
with torch.no_grad():
    o = model(pixel_values=(x - mean) / std)
cls = o.pooler_output[0]
cls = cls / cls.norm()
(out / "kitchen-cls.json").write_text(json.dumps([round(float(v), 6) for v in cls]))
print("wrote", out, file=sys.stderr)
