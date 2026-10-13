"""SVG rasterizer used by make-icons.mjs. Python 3.12, PyMuPDF 1.27.2.2, Pillow 12.

Reads one JSON array from stdin and returns PNG (or RGB BMP) buffers as base64.
No browser, application profile, filesystem output or network access is needed.
"""
import base64
import io
import json
import sys

import pymupdf
from PIL import Image


def render(job):
    width, height = job["width"], job["height"]
    with pymupdf.open(stream=job["svg"].encode("utf-8"), filetype="svg") as doc:
        page = doc[0]
        # Supersampling keeps small curves clean and gives consistent transparent edges.
        scale = 4 if max(width, height) <= 512 else 1
        pix = page.get_pixmap(
            matrix=pymupdf.Matrix(width * scale / page.rect.width, height * scale / page.rect.height),
            alpha=True,
        )
        with Image.open(io.BytesIO(pix.tobytes("png"))) as rendered:
            image = rendered.resize((width, height), Image.Resampling.LANCZOS)
            # Remove nearly invisible Lanczos ringing outside the icon silhouette.
            image.putalpha(image.getchannel("A").point(lambda alpha: 0 if alpha < 4 else alpha))
            result = io.BytesIO()
            if job.get("format") == "bmp":
                image.convert("RGB").save(result, format="BMP")
            else:
                image.save(result, format="PNG")
    return base64.b64encode(result.getvalue()).decode("ascii")


if __name__ == "__main__":
    jobs = json.loads(sys.stdin.buffer.read())
    sys.stdout.write(json.dumps([render(job) for job in jobs]))
