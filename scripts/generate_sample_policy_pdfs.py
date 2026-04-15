from pathlib import Path
import textwrap


ROOT = Path(r"C:\Users\vmadmin\sarvam-multi-agent-app")
SOURCE_DIR = ROOT / "sample-policies"

PAGE_WIDTH = 612
PAGE_HEIGHT = 792
LEFT_MARGIN = 54
TOP_MARGIN = 64
BOTTOM_MARGIN = 56
LINE_HEIGHT = 16
FONT_SIZE = 11
MAX_CHARS = 92


def pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def wrap_text(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        stripped = raw_line.rstrip()
        if not stripped:
            lines.append("")
            continue
        lines.extend(textwrap.wrap(stripped, width=MAX_CHARS) or [""])
    return lines


def build_pages(lines: list[str]) -> list[list[str]]:
    lines_per_page = (PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN) // LINE_HEIGHT
    pages: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        current.append(line)
        if len(current) >= lines_per_page:
            pages.append(current)
            current = []
    if current or not pages:
        pages.append(current)
    return pages


def build_content_stream(page_lines: list[str]) -> bytes:
    y = PAGE_HEIGHT - TOP_MARGIN
    commands = ["BT", f"/F1 {FONT_SIZE} Tf"]
    for line in page_lines:
        safe = pdf_escape(line)
        commands.append(f"1 0 0 1 {LEFT_MARGIN} {y} Tm ({safe}) Tj")
        y -= LINE_HEIGHT
    commands.append("ET")
    return "\n".join(commands).encode("latin-1", errors="replace")


def add_object(objects: list[bytes], body: bytes) -> int:
    objects.append(body)
    return len(objects)


def build_pdf_bytes(title: str, text: str) -> bytes:
    lines = [title, ""] + wrap_text(text)
    pages = build_pages(lines)

    objects: list[bytes] = []

    font_id = add_object(objects, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids: list[int] = []

    content_ids: list[int] = []
    for page in pages:
        stream = build_content_stream(page)
        content = (
            f"<< /Length {len(stream)} >>\nstream\n".encode("ascii")
            + stream
            + b"\nendstream"
        )
        content_ids.append(add_object(objects, content))

    pages_id_placeholder = len(objects) + 1
    for content_id in content_ids:
        page_body = (
            f"<< /Type /Page /Parent {pages_id_placeholder} 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>"
        ).encode("ascii")
        page_ids.append(add_object(objects, page_body))

    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    pages_id = add_object(
        objects,
        f"<< /Type /Pages /Count {len(page_ids)} /Kids [{kids}] >>".encode("ascii"),
    )
    catalog_id = add_object(objects, f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("ascii"))

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode("ascii"))
        pdf.extend(obj)
        pdf.extend(b"\nendobj\n")

    xref_start = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
            f"startxref\n{xref_start}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(pdf)


def main() -> None:
    for source_path in sorted(SOURCE_DIR.iterdir()):
      if source_path.suffix.lower() not in {".md", ".txt"}:
          continue
      title = source_path.stem.replace("-", " ").title()
      text = source_path.read_text(encoding="utf-8")
      pdf_bytes = build_pdf_bytes(title, text)
      output_path = source_path.with_suffix(".pdf")
      output_path.write_bytes(pdf_bytes)
      print(f"Created {output_path}")


if __name__ == "__main__":
    main()
