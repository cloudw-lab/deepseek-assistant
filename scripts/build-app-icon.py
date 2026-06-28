from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'build' / 'deepseek-logo-source.png'
OUTPUT = ROOT / 'build' / 'app-icon-1024.png'
ICONSET = ROOT / 'build' / 'icon.iconset'


def load_font(size: int):
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/System/Library/Fonts/SFNS.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except Exception:
                pass
    return ImageFont.load_default()


def main():
    ICONSET.mkdir(parents=True, exist_ok=True)

    logo = Image.open(SOURCE).convert('RGBA')
    canvas = Image.new('RGBA', (1024, 1024), (255, 255, 255, 0))
    draw = ImageDraw.Draw(canvas)

    blue = (69, 99, 235, 255)
    panel = (255, 255, 255, 255)
    shadow = (44, 73, 180, 36)
    text = 'desktop'

    draw.rounded_rectangle((56, 56, 968, 968), radius=220, fill=shadow)
    draw.rounded_rectangle((40, 40, 952, 952), radius=220, fill=panel)

    max_logo_width = 820
    scale = max_logo_width / logo.width
    logo_size = (int(logo.width * scale), int(logo.height * scale))
    logo = logo.resize(logo_size, Image.LANCZOS)

    font = load_font(108)
    text_bbox = draw.textbbox((0, 0), text, font=font)
    text_width = text_bbox[2] - text_bbox[0]
    text_height = text_bbox[3] - text_bbox[1]

    spacing = 28
    total_height = logo.height + spacing + text_height
    top = (1024 - total_height) // 2 - 10
    logo_left = (1024 - logo.width) // 2
    canvas.alpha_composite(logo, (logo_left, top))

    text_left = (1024 - text_width) // 2
    text_top = top + logo.height + spacing - text_bbox[1]
    draw.text((text_left, text_top), text, font=font, fill=blue)

    canvas.save(OUTPUT)

    sizes = {
        '16x16': 16,
        '16x16@2x': 32,
        '32x32': 32,
        '32x32@2x': 64,
        '128x128': 128,
        '128x128@2x': 256,
        '256x256': 256,
        '256x256@2x': 512,
        '512x512': 512,
        '512x512@2x': 1024,
    }
    for name, size in sizes.items():
        resized = canvas.resize((size, size), Image.LANCZOS)
        resized.save(ICONSET / f'icon_{name}.png')


if __name__ == '__main__':
    main()
