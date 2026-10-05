# -*- coding: utf-8 -*-
"""
وحدة معالجة الملفات والتقارير:
1. تصدير واستيراد ملفات الإكسل (openpyxl) مع معالج التحقق وفض التعارض.
2. تصدير مستندات الوورد (python-docx) بنوعيها: بطاقات مستقلة وكشف جدولي مجمع.
3. إدارة وتأكيد النسخ الاحتياطية واسترجاعها.
"""

import os
import shutil
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
from docx.shared import Inches, Pt, RGBColor

from database import Database


# ==================== تنسيقات إكسل ====================

def export_employees_to_excel(
    employees: List[Dict[str, Any]],
    active_fields: List[Dict[str, Any]],
    output_path: str
) -> str:
    """
    تصدير قائمة الموظفين مع الحقول الأساسية والمخصصة إلى ملف إكسل بتنسيق عربي RTL واحترافي.
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "سجل الموظفين"

    # تفعيل اتجاه الورقة من اليمين لليسار (RTL)
    ws.views.sheetView[0].rightToLeft = True

    # تعريف العناوين الرئيسية
    headers = [
        ("الرقم الوطني", "national_id"),
        ("الاسم الكامل", "full_name"),
        ("الحالة الوظيفية", "status_name"),
        ("تاريخ التعيين", "hire_date"),
        ("القسم / الإدارة", "department"),
        ("الدرجة الحالية", "current_grade"),
        ("تاريخ الدرجة", "grade_date"),
        ("المؤهل العلمي", "education_level"),
        ("التخصص", "specialization")
    ]

    # إضافة الحقول الديناميكية النشطة
    for af in active_fields:
        headers.append((af["label"], f"custom_{af['field_key']}"))

    # تطبيق الترويسة
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid") # كحلي ملكي
    header_font = Font(name="Segoe UI", size=11, bold=True, color="FFFFFF")
    center_align = Alignment(horizontal="center", vertical="center", wrap_text=True)
    thin_border_side = Side(border_style="thin", color="CCCCCC")
    header_border = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thin_border_side)

    ws.row_dimensions[1].height = 28

    for col_idx, (header_label, _) in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header_label)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center_align
        cell.border = header_border

    # كتابة بيانات الموظفين
    data_font = Font(name="Segoe UI", size=10)
    data_border = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thin_border_side)
    stripe_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")

    for row_idx, emp in enumerate(employees, start=2):
        ws.row_dimensions[row_idx].height = 22
        is_even = (row_idx % 2 == 0)

        for col_idx, (_, key) in enumerate(headers, start=1):
            if key.startswith("custom_"):
                fkey = key.replace("custom_", "")
                val = emp.get("custom_values", {}).get(fkey, "")
            else:
                val = emp.get(key, "")

            val = "" if val is None else str(val)

            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.font = data_font
            cell.alignment = Alignment(horizontal="right" if col_idx == 2 else "center", vertical="center")
            cell.border = data_border
            if is_even:
                cell.fill = stripe_fill

    # ضبط عروض الأعمدة تلقائياً بناءً على المحتوى
    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            v_str = str(cell.value or "")
            max_len = max(max_len, len(v_str))
        ws.column_dimensions[col_letter].width = max(max_len + 4, 14)

    wb.save(output_path)
    return output_path


# ==================== معالج استيراد إكسل ====================

def parse_and_validate_excel_file(
    file_path: str,
    db: Database
) -> Dict[str, Any]:
    """
    المرحلة الأولى والثانية من معالج الاستيراد:
    1. التحقق من سلامة البيانات ووجود [الرقم الوطني / الاسم] في كل سطر.
       إذا فُقد أحدهما في أي سطر يتم إيقاف العملية فوراً مع نص الخطأ المطلوب.
    2. فحص السجلات ومقارنتها بقاعدة البيانات لاكتشاف التعارضات.
    """
    if not os.path.exists(file_path):
        return {"success": False, "error": "ملف الإكسل المحدد غير موجود"}

    try:
        wb = openpyxl.load_workbook(file_path, data_only=True)
        ws = wb.active
    except Exception as e:
        return {"success": False, "error": f"تعذر فتح ملف الإكسل: {str(e)}"}

    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return {"success": False, "error": "الملف فارغ ولا يحتوي على بيانات"}

    # قراءة الترويسة
    header_row = rows[0]
    header_map: Dict[str, int] = {}
    for idx, cell_val in enumerate(header_row):
        if cell_val is not None:
            clean_val = str(cell_val).strip()
            header_map[clean_val] = idx

    # مطابقة الحقول الأساسية
    def find_col(candidates: List[str]) -> Optional[int]:
        for c in candidates:
            for h, idx in header_map.items():
                if c in h.lower() or c in h:
                    return idx
        return None

    col_nat_id = find_col(["الرقم الوطني", "رقم وطني", "national_id"])
    col_name = find_col(["الاسم الكامل", "الاسم", "full_name"])
    col_status = find_col(["الحالة الوظيفية", "الحالة", "status"])
    col_hire_date = find_col(["تاريخ التعيين", "hire_date"])
    col_department = find_col(["القسم", "الإدارة", "department"])
    col_current_grade = find_col(["الدرجة الحالية", "الدرجة", "current_grade"])
    col_grade_date = find_col(["تاريخ الدرجة", "grade_date"])
    col_education = find_col(["المؤهل العلمي", "المؤهل", "education_level"])
    col_specialization = find_col(["التخصص", "specialization"])

    if col_nat_id is None or col_name is None:
        return {
            "success": False,
            "error": "لم يتم العثور على أعمدة [الرقم الوطني] و [الاسم] في السطر الأول من ملف الإكسل. يرجى التأكد من الترويسة."
        }

    # جلب الحالات الوظيفية لربطها بالأسماء
    db_statuses = db.get_statuses()
    status_name_to_id = {s["name"].strip(): s["id"] for s in db_statuses}
    default_status_id = db_statuses[0]["id"] if db_statuses else 1

    # جلب الحقول المخصصة النشطة
    active_fields = db.get_fields(active_only=True)
    custom_col_map: Dict[str, int] = {}
    for af in active_fields:
        fidx = find_col([af["label"], af["field_key"]])
        if fidx is not None:
            custom_col_map[af["field_key"]] = fidx

    # المرحلة 1: التحقق الصارم من الصفوف
    parsed_records = []
    for row_num, row_data in enumerate(rows[1:], start=2):
        # تجاهل الصفوف الفارغة بالكامل
        if not any(row_data):
            continue

        raw_nat_id = row_data[col_nat_id] if col_nat_id < len(row_data) else None
        raw_name = row_data[col_name] if col_name < len(row_data) else None

        nat_id_str = str(raw_nat_id).strip() if raw_nat_id is not None else ""
        # إزالة الفواصل العشرية إذا أرجع إكسل أرقاماً بتنسيق float
        if nat_id_str.endswith(".0"):
            nat_id_str = nat_id_str[:-2]

        name_str = str(raw_name).strip() if raw_name is not None else ""

        # التحقق من الإلزامية: التوقف الفوري عند وجود خطأ
        if not nat_id_str or not name_str:
            return {
                "success": False,
                "error": f"توقفت العملية: الملف يحتوي على خطأ في السطر رقم ({row_num}) لعدم وجود [الرقم الوطني / الاسم]. يرجى تصحيح الخطأ في ملف الإكسل والمحاولة مرة أخرى."
            }

        # استخراج باقي الحقول
        def get_cell(c_idx):
            if c_idx is not None and c_idx < len(row_data) and row_data[c_idx] is not None:
                v = str(row_data[c_idx]).strip()
                return v[:-2] if v.endswith(".0") else v
            return ""

        status_text = get_cell(col_status)
        matched_status_id = status_name_to_id.get(status_text, default_status_id)

        custom_vals = {}
        for fkey, fcol in custom_col_map.items():
            custom_vals[fkey] = get_cell(fcol)

        record = {
            "row_num": row_num,
            "national_id": nat_id_str,
            "full_name": name_str,
            "status_id": matched_status_id,
            "hire_date": get_cell(col_hire_date),
            "department": get_cell(col_department),
            "current_grade": get_cell(col_current_grade),
            "grade_date": get_cell(col_grade_date),
            "education_level": get_cell(col_education),
            "specialization": get_cell(col_specialization),
            "custom_values": custom_vals
        }
        parsed_records.append(record)

    if not parsed_records:
        return {"success": False, "error": "لم يتم العثور على أي صفوف صالحة للبيانات في الملف"}

    # المرحلة 2: فحص التعارضات مع قاعدة البيانات
    new_records = []
    conflicts = []

    for rec in parsed_records:
        exists, existing_row = db.check_national_id_exists(rec["national_id"])
        if exists and existing_row:
            conflicts.append({
                "national_id": rec["national_id"],
                "existing_id": existing_row["id"],
                "existing_name": existing_row["full_name"],
                "new_name": rec["full_name"],
                "incoming_record": rec
            })
        else:
            new_records.append(rec)

    return {
        "success": True,
        "total_rows": len(parsed_records),
        "new_records": new_records,
        "conflicts": conflicts
    }


def execute_import_commit(
    new_records: List[Dict[str, Any]],
    resolved_conflicts: List[Dict[str, Any]],
    db: Database
) -> Dict[str, Any]:
    """
    تنفيذ استيراد السجلات الجديدة وتحديث/تخطي السجلات المتعارضة بحسب خيارات المستخدم
    """
    inserted_count = 0
    updated_count = 0
    skipped_count = 0

    try:
        # إدراج السجلات الجديدة
        for rec in new_records:
            emp_data = {
                "national_id": rec["national_id"],
                "full_name": rec["full_name"],
                "status_id": rec["status_id"],
                "hire_date": rec.get("hire_date"),
                "department": rec.get("department"),
                "current_grade": rec.get("current_grade"),
                "grade_date": rec.get("grade_date"),
                "education_level": rec.get("education_level"),
                "specialization": rec.get("specialization")
            }
            db.save_employee(emp_data, rec.get("custom_values"))
            inserted_count += 1

        # معالجة التعارضات
        for conflict in resolved_conflicts:
            action = conflict.get("action")  # 'update' أو 'skip'
            inc = conflict.get("incoming_record", {})
            existing_id = conflict.get("existing_id")

            if action == "update" and existing_id:
                emp_data = {
                    "id": existing_id,
                    "national_id": inc["national_id"],
                    "full_name": inc["full_name"],
                    "status_id": inc["status_id"],
                    "hire_date": inc.get("hire_date"),
                    "department": inc.get("department"),
                    "current_grade": inc.get("current_grade"),
                    "grade_date": inc.get("grade_date"),
                    "education_level": inc.get("education_level"),
                    "specialization": inc.get("specialization")
                }
                db.save_employee(emp_data, inc.get("custom_values"))
                updated_count += 1
            else:
                skipped_count += 1

        return {
            "success": True,
            "inserted_count": inserted_count,
            "updated_count": updated_count,
            "skipped_count": skipped_count,
            "message": f"تمت عملية الاستيراد بنجاح: تم إدخال ({inserted_count}) موظف جديد، وتحديث ({updated_count}) موظف، وتخطي ({skipped_count}) سجل."
        }
    except Exception as e:
        return {"success": False, "error": f"حدث خطأ أثناء حفظ البيانات المستوردة: {str(e)}"}


# ==================== تصدير مستندات وورد (python-docx) ====================

def _set_cell_background(cell, fill_hex: str):
    """تلوين خلفية خلية الجدول في وورد"""
    shading_xml = f'<w:shd {nsdecls("w")} w:val="clear" w:color="auto" w:fill="{fill_hex}"/>'
    cell._tc.get_or_add_tcPr().append(parse_xml(shading_xml))


def _set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """ضبط هوامش الخلية بالـ twips"""
    tcMar = parse_xml(f'<w:tcMar {nsdecls("w")}><w:top w:w="{top}" w:type="dxa"/><w:bottom w:w="{bottom}" w:type="dxa"/><w:left w:w="{left}" w:type="dxa"/><w:right w:w="{right}" w:type="dxa"/></w:tcMar>')
    cell._tc.get_or_add_tcPr().append(tcMar)


def _apply_rtl_to_paragraph(p):
    """تطبيق اتجاه RTL ومحاذاة اليمين للفقرة في وورد"""
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    pPr = p._p.get_or_add_pPr()
    pPr.append(parse_xml(f'<w:bidi {nsdecls("w")}/>'))


def _apply_rtl_to_table(table):
    """تطبيق اتجاه RTL للجدول بأكمله في وورد"""
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tblPr = table._tbl.tblPr
    tblPr.append(parse_xml(f'<w:bidiVisual {nsdecls("w")}/>'))


def export_word_employee_cards(
    employees: List[Dict[str, Any]],
    active_fields: List[Dict[str, Any]],
    selected_fields: Optional[List[str]],
    output_path: str
) -> str:
    """
    توليد بطاقة موظف مستقلة (صفحة A4 أنيقة لكل موظف) بصيغة docx
    """
    doc = docx.Document()

    # هوامش قياسية A4
    for section in doc.sections:
        section.top_margin = Inches(0.6)
        section.bottom_margin = Inches(0.6)
        section.left_margin = Inches(0.6)
        section.right_margin = Inches(0.6)

    # إعداد الحقول المراد طباعتها
    core_field_labels = [
        ("national_id", "الرقم الوطني"),
        ("full_name", "الاسم الكامل"),
        ("status_name", "الحالة الوظيفية"),
        ("hire_date", "تاريخ التعيين"),
        ("department", "القسم / الإدارة"),
        ("current_grade", "الدرجة الحالية"),
        ("grade_date", "تاريخ الدرجة"),
        ("education_level", "المؤهل العلمي"),
        ("specialization", "التخصص")
    ]

    all_field_defs = []
    for key, lbl in core_field_labels:
        if not selected_fields or key in selected_fields:
            all_field_defs.append((key, lbl, False))

    for af in active_fields:
        fkey = f"custom_{af['field_key']}"
        if not selected_fields or fkey in selected_fields or af['field_key'] in selected_fields:
            all_field_defs.append((af["field_key"], af["label"], True))

    for emp_idx, emp in enumerate(employees):
        if emp_idx > 0:
            doc.add_page_break()

        # ترويسة البطاقة
        title_p = doc.add_paragraph()
        _apply_rtl_to_paragraph(title_p)
        title_p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = title_p.add_run("سجل بيانات موظف")
        run.font.name = "Segoe UI"
        run.font.size = Pt(18)
        run.font.bold = True
        run.font.color.rgb = RGBColor(30, 58, 138)

        # خط فاصل
        sub_p = doc.add_paragraph()
        _apply_rtl_to_paragraph(sub_p)
        sub_p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sub_run = sub_p.add_run(f"تاريخ التقرير: {datetime.now().strftime('%Y-%m-%d')}  |  الرقم الوطني: {emp.get('national_id', '')}")
        sub_run.font.name = "Segoe UI"
        sub_run.font.size = Pt(10)
        sub_run.font.color.rgb = RGBColor(100, 116, 139)

        # مسافة
        space_p = doc.add_paragraph()
        space_p.paragraph_format.space_before = Pt(4)
        space_p.paragraph_format.space_after = Pt(4)

        # جدول بيانات الموظف
        table = doc.add_table(rows=len(all_field_defs), cols=2)
        _apply_rtl_to_table(table)

        for row_i, (f_key, f_label, is_custom) in enumerate(all_field_defs):
            row = table.rows[row_i]
            # منع انقسام الصف عبر الصفحات
            trPr = row._tr.get_or_add_trPr()
            trPr.append(parse_xml(f'<w:cantSplit {nsdecls("w")}/>'))

            # الخلية 0: التسمية
            label_cell = row.cells[0]
            label_cell.width = Inches(2.2)
            _set_cell_background(label_cell, "F1F5F9")
            _set_cell_margins(label_cell, top=120, bottom=120, left=180, right=180)
            lp = label_cell.paragraphs[0]
            _apply_rtl_to_paragraph(lp)
            lrun = lp.add_run(f_label)
            lrun.font.name = "Segoe UI"
            lrun.font.bold = True
            lrun.font.size = Pt(10.5)
            lrun.font.color.rgb = RGBColor(30, 41, 59)

            # الخلية 1: القيمة
            val_cell = row.cells[1]
            val_cell.width = Inches(4.8)
            _set_cell_margins(val_cell, top=120, bottom=120, left=180, right=180)
            vp = val_cell.paragraphs[0]
            _apply_rtl_to_paragraph(vp)

            if is_custom:
                val = emp.get("custom_values", {}).get(f_key, "")
            else:
                val = emp.get(f_key, "")

            val = "-" if not val else str(val)
            vrun = vp.add_run(val)
            vrun.font.name = "Segoe UI"
            vrun.font.size = Pt(10.5)

        # مسافة وختام رسمي
        doc.add_paragraph()
        footer_p = doc.add_paragraph()
        _apply_rtl_to_paragraph(footer_p)
        f_run = footer_p.add_run("اعتماد شؤون الموظفين: ____________________                     التوقيع / الختم: ____________________")
        f_run.font.name = "Segoe UI"
        f_run.font.size = Pt(9.5)
        f_run.font.color.rgb = RGBColor(71, 85, 105)

    doc.save(output_path)
    return output_path


def export_word_employee_table(
    employees: List[Dict[str, Any]],
    active_fields: List[Dict[str, Any]],
    selected_fields: Optional[List[str]],
    output_path: str
) -> str:
    """
    توليد كشف جدولي مجمع لكافة الموظفين المحددين في وورد مع تكرار ترويسة الجدول في كل صفحة
    """
    doc = docx.Document()

    # تنسيق أفقي ليتسع للأعمدة
    for section in doc.sections:
        section.orientation = docx.enum.section.WD_ORIENT.LANDSCAPE
        section.page_width = Inches(11.69)   # A4 عرضي
        section.page_height = Inches(8.27)
        section.top_margin = Inches(0.5)
        section.bottom_margin = Inches(0.5)
        section.left_margin = Inches(0.5)
        section.right_margin = Inches(0.5)

    # عنوان الكشف
    title_p = doc.add_paragraph()
    _apply_rtl_to_paragraph(title_p)
    title_p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    trun = title_p.add_run("كشف موظفين مجمع")
    trun.font.name = "Segoe UI"
    trun.font.size = Pt(16)
    trun.font.bold = True
    trun.font.color.rgb = RGBColor(30, 58, 138)

    info_p = doc.add_paragraph()
    _apply_rtl_to_paragraph(info_p)
    info_p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    irun = info_p.add_run(f"تاريخ التقرير: {datetime.now().strftime('%Y-%m-%d')}  |  العدد الإجمالي: {len(employees)} موظف")
    irun.font.name = "Segoe UI"
    irun.font.size = Pt(10)
    irun.font.color.rgb = RGBColor(100, 116, 139)

    # تحديد الأعمدة
    core_columns = [
        ("national_id", "الرقم الوطني"),
        ("full_name", "الاسم الكامل"),
        ("status_name", "الحالة"),
        ("hire_date", "تاريخ التعيين"),
        ("department", "القسم"),
        ("current_grade", "الدرجة"),
        ("grade_date", "تاريخ الدرجة"),
        ("education_level", "المؤهل"),
        ("specialization", "التخصص")
    ]

    selected_cols = []
    for key, lbl in core_columns:
        if not selected_fields or key in selected_fields:
            selected_cols.append((key, lbl, False))

    for af in active_fields:
        fkey = f"custom_{af['field_key']}"
        if not selected_fields or fkey in selected_fields or af['field_key'] in selected_fields:
            selected_cols.append((af["field_key"], af["label"], True))

    if not selected_cols:
        selected_cols = [(k, l, False) for k, l in core_columns[:4]]

    table = doc.add_table(rows=len(employees) + 1, cols=len(selected_cols))
    _apply_rtl_to_table(table)

    # رأس الجدول
    header_row = table.rows[0]
    trPr = header_row._tr.get_or_add_trPr()
    # تكرار ترويسة الجدول في كل صفحة ومنع الانقسام
    trPr.append(parse_xml(f'<w:tblHeader {nsdecls("w")}/>'))
    trPr.append(parse_xml(f'<w:cantSplit {nsdecls("w")}/>'))

    for col_i, (_, col_lbl, _) in enumerate(selected_cols):
        cell = header_row.cells[col_i]
        _set_cell_background(cell, "1E3A8A")
        _set_cell_margins(cell, top=100, bottom=100, left=100, right=100)
        p = cell.paragraphs[0]
        _apply_rtl_to_paragraph(p)
        p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(col_lbl)
        run.font.name = "Segoe UI"
        run.font.bold = True
        run.font.size = Pt(9.5)
        run.font.color.rgb = RGBColor(255, 255, 255)

    # صفوف البيانات
    for emp_i, emp in enumerate(employees, start=1):
        row = table.rows[emp_i]
        r_trPr = row._tr.get_or_add_trPr()
        r_trPr.append(parse_xml(f'<w:cantSplit {nsdecls("w")}/>'))
        is_even = (emp_i % 2 == 0)

        for col_i, (f_key, _, is_custom) in enumerate(selected_cols):
            cell = row.cells[col_i]
            if is_even:
                _set_cell_background(cell, "F8FAFC")
            _set_cell_margins(cell, top=80, bottom=80, left=80, right=80)
            p = cell.paragraphs[0]
            _apply_rtl_to_paragraph(p)
            p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.RIGHT if col_i == 1 else WD_ALIGN_PARAGRAPH.CENTER

            if is_custom:
                val = emp.get("custom_values", {}).get(f_key, "")
            else:
                val = emp.get(f_key, "")

            val = "-" if not val else str(val)
            run = p.add_run(val)
            run.font.name = "Segoe UI"
            run.font.size = Pt(9)

    doc.save(output_path)
    return output_path


# ==================== النسخ الاحتياطي والاسترجاع ====================

def backup_database_to_file(source_db_path: str, dest_file_path: str) -> Dict[str, Any]:
    """نسخ ملف قاعدة البيانات باستخدام Backup API الأصلي لـ SQLite لضمان سلامة بيانات WAL"""
    try:
        if not os.path.exists(source_db_path):
            return {"success": False, "error": "ملف قاعدة البيانات الحالي غير موجود"}
        
        # التأكد من إنشاء المجلد الوجهة إذا لم يكن موجوداً
        dest_dir = os.path.dirname(dest_file_path)
        if dest_dir and not os.path.exists(dest_dir):
            os.makedirs(dest_dir, exist_ok=True)

        import sqlite3
        source_conn = sqlite3.connect(source_db_path)
        dest_conn = sqlite3.connect(dest_file_path)
        with dest_conn:
            source_conn.backup(dest_conn)
        dest_conn.close()
        source_conn.close()

        return {"success": True, "message": "تم حفظ النسخة الاحتياطية بنجاح"}
    except Exception as e:
        return {"success": False, "error": f"تعذر إنشاء النسخة الاحتياطية: {str(e)}"}


def restore_database_from_file(source_file_path: str, target_db_path: str) -> Dict[str, Any]:
    """استرجاع قاعدة البيانات بعد التأكد من مطابقة هيكل الجداول باستخدام Backup API الأصلي"""
    try:
        if not Database.validate_database_file(source_file_path):
            return {
                "success": False,
                "error": "الملف المحدد ليس نسخة احتياطية صالحة أو لا يحتوي على هيكل الجداول المطلوب."
            }

        import sqlite3
        backup_conn = sqlite3.connect(source_file_path)
        target_conn = sqlite3.connect(target_db_path)
        with target_conn:
            backup_conn.backup(target_conn)
        target_conn.close()
        backup_conn.close()

        return {"success": True, "message": "تم استرجاع النسخة الاحتياطية بنجاح"}
    except Exception as e:
        return {"success": False, "error": f"فشل استرجاع النسخة الاحتياطية: {str(e)}"}
