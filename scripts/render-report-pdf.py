import html
import json
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


def main() -> None:
    output_path = sys.argv[1]
    model = json.load(sys.stdin)
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    title_style = ParagraphStyle(
        "Title",
        fontName="STSong-Light",
        fontSize=22,
        leading=30,
        textColor=colors.HexColor("#122033"),
        spaceAfter=10 * mm,
    )
    question_style = ParagraphStyle(
        "Question",
        fontName="STSong-Light",
        fontSize=11,
        leading=18,
        backColor=colors.HexColor("#EEF7F5"),
        borderColor=colors.HexColor("#22C3A6"),
        borderWidth=1,
        borderPadding=8,
        spaceAfter=7 * mm,
    )
    heading_style = ParagraphStyle(
        "Heading",
        fontName="STSong-Light",
        fontSize=16,
        leading=22,
        textColor=colors.HexColor("#087F72"),
        spaceBefore=5 * mm,
        spaceAfter=2 * mm,
    )
    body_style = ParagraphStyle(
        "Body",
        fontName="STSong-Light",
        fontSize=10,
        leading=16,
        leftIndent=4 * mm,
        firstLineIndent=-3 * mm,
        alignment=TA_LEFT,
        spaceAfter=2 * mm,
    )
    story = [
        Paragraph(html.escape(model["title"]), title_style),
        Paragraph(f"研究问题：{html.escape(model['question'])}", question_style),
    ]
    for section in model["sections"]:
        story.append(Paragraph(html.escape(section["heading"]), heading_style))
        for item in section["items"]:
            story.append(Paragraph(f"• {html.escape(item)}", body_style))
        story.append(Spacer(1, 1 * mm))
    document = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=model["title"],
        author="InsightForge",
    )
    document.build(story)


if __name__ == "__main__":
    main()
