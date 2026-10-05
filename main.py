# -*- coding: utf-8 -*-
"""
الملف الرئيسي لتشغيل تطبيق إدارة سجل الموظفين المحمول (SSS)
يقوم بتهيئة محرك pywebview ونافذة النظام وربط دوال البايثون بواجهة الجافاسكربت (JS-Python API Bridge)
"""

import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

# ضمان احتواء مسار بايثون على المجلد الحالي
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

import webview

from database import Database
from file_operations import (
    backup_database_to_file,
    execute_import_commit,
    export_employees_to_excel,
    export_word_employee_cards,
    export_word_employee_table,
    parse_and_validate_excel_file,
    restore_database_from_file
)


def get_base_dir() -> str:
    """تحديد مجلد تشغيل التطبيق (سواء ككود بايثون أو كملف تنفيذي مجمع بـ PyInstaller)"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def get_frontend_dir() -> str:
    """تحديد مسار مجلد واجهة المستخدم frontend"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, "frontend")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")


class AppAPI:
    """
    جسر التواصل البرمجي بين واجهة المستخدم (JavaScript) وخلفية النظام (Python)
    """

    def __init__(self, db: Database):
        self._db = db
        self._window: Optional[webview.Window] = None
        self._current_user: Optional[Dict[str, Any]] = None

    def _set_window(self, window: webview.Window):
        self._window = window

    # ==================== التهيئة والمصادقة ====================

    def get_initial_data(self) -> Dict[str, Any]:
        """جلب البيانات الأساسية لبدء تشغيل التطبيق (قائمة المستخدمين والحالات والحقول النشطة)"""
        try:
            users = self._db.get_users()
            statuses = self._db.get_statuses(active_only=True)
            active_fields = self._db.get_fields(active_only=True)
            return {
                "success": True,
                "users": users,
                "statuses": statuses,
                "active_fields": active_fields
            }
        except Exception as e:
            return {"success": False, "error": f"تعذر تحميل البيانات الأولية: {str(e)}"}

    def login(self, user_id: int, pin_code: str) -> Dict[str, Any]:
        """تسجيل الدخول والتحقق من رمز PIN للمستخدم"""
        try:
            user = self._db.authenticate_user(user_id, pin_code)
            if user:
                self._current_user = user
                return {"success": True, "user": user}
            return {"success": False, "error": "رمز المرور (PIN) غير صحيح"}
        except Exception as e:
            return {"success": False, "error": f"حدث خطأ أثناء تسجيل الدخول: {str(e)}"}

    def logout(self) -> Dict[str, Any]:
        """تسجيل الخروج وإنهاء الجلسة الحالية"""
        self._current_user = None
        return {"success": True}

    def get_current_user(self) -> Optional[Dict[str, Any]]:
        """الحصول على بيانات المستخدم المسجل حالياً"""
        return self._current_user

    # ==================== إدارة الموظفين ====================

    def get_employees(
        self,
        search_name: str = "",
        search_national_id: str = "",
        status_id: Optional[Any] = None
    ) -> Dict[str, Any]:
        """استرجاع قائمة الموظفين وفق معايير البحث والفلترة"""
        try:
            status_filter = None
            if status_id not in (None, "", "all", 0, "0"):
                try:
                    status_filter = int(status_id)
                except ValueError:
                    pass

            employees = self._db.get_employees(
                search_name=search_name,
                search_national_id=search_national_id,
                status_id=status_filter
            )
            return {"success": True, "employees": employees}
        except Exception as e:
            return {"success": False, "error": f"تعذر جلب سجلات الموظفين: {str(e)}"}

    def get_employee(self, emp_id: int) -> Dict[str, Any]:
        """جلب تفاصيل موظف محدد"""
        try:
            emp = self._db.get_employee(emp_id)
            if emp:
                return {"success": True, "employee": emp}
            return {"success": False, "error": "لم يتم العثور على الموظف المطلوب"}
        except Exception as e:
            return {"success": False, "error": f"حدث خطأ أثناء جلب بيانات الموظف: {str(e)}"}

    def check_national_id(self, national_id: str, exclude_id: Optional[int] = None) -> Dict[str, Any]:
        """التحقق السريع والفوري من تكرار الرقم الوطني (يستدعى عند blur)"""
        try:
            exists, existing = self._db.check_national_id_exists(national_id, exclude_id)
            return {
                "success": True,
                "exists": exists,
                "existing_name": existing["full_name"] if existing else None
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def save_employee(self, data: Dict[str, Any], custom_values: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """إضافة أو تعديل موظف مع الحقول المخصصة"""
        try:
            result = self._db.save_employee(data, custom_values)
            return {"success": True, "employee": result, "message": "تم حفظ بيانات الموظف بنجاح"}
        except ValueError as ve:
            return {"success": False, "error": str(ve)}
        except Exception as e:
            return {"success": False, "error": f"تعذر حفظ السجل، يرجى التأكد من ملء الحقول المطلوبة: {str(e)}"}

    def update_employee_status(self, emp_id: int, status_id: int) -> Dict[str, Any]:
        """تحديث الحالة الوظيفية للموظف (كالحذف الروتيني بالتحويل لمنقطع أو متقاعد)"""
        try:
            success = self._db.update_employee_status(emp_id, status_id)
            if success:
                return {"success": True, "message": "تم تحديث حالة الموظف بنجاح"}
            return {"success": False, "error": "تعذر تحديث الحالة"}
        except Exception as e:
            return {"success": False, "error": f"حدث خطأ أثناء تغيير الحالة: {str(e)}"}

    def delete_employee_permanent(self, emp_id: int) -> Dict[str, Any]:
        """الحذف النهائي من قاعدة البيانات (صلاحية مدير النظام فقط)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        try:
            success = self._db.delete_employee_permanent(emp_id)
            if success:
                return {"success": True, "message": "تم حذف السجل نهائياً من قاعدة البيانات"}
            return {"success": False, "error": "لم يتم العثور على السجل لحذفه"}
        except Exception as e:
            return {"success": False, "error": f"تعذر إتمام الحذف: {str(e)}"}

    def delete_employees_batch(self, emp_ids: List[int]) -> Dict[str, Any]:
        """حذف دفعة من الموظفين نهائياً من قاعدة البيانات (صلاحية مدير النظام فقط)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        if not emp_ids or not isinstance(emp_ids, list):
            return {"success": False, "error": "يرجى تحديد سجل واحد على الأقل للحذف"}

        try:
            cleaned_ids = [int(i) for i in emp_ids if str(i).isdigit() or isinstance(i, int)]
            if not cleaned_ids:
                return {"success": False, "error": "قائمة المعرفات المحددة غير صالحة"}

            deleted_count = self._db.delete_employees_batch(cleaned_ids)
            if deleted_count > 0:
                return {
                    "success": True,
                    "deleted_count": deleted_count,
                    "message": f"تم حذف عدد ({deleted_count}) سجل نهائياً من قاعدة البيانات"
                }
            return {"success": False, "error": "لم يتم العثور على أي سجلات لحذفها"}
        except Exception as e:
            return {"success": False, "error": f"تعذر إتمام الحذف الجماعي: {str(e)}"}

    # ==================== إدارة الحقول الديناميكية والحالات ====================

    def get_all_fields(self) -> Dict[str, Any]:
        """جلب كافة الحقول الديناميكية لإدارتها"""
        try:
            fields = self._db.get_fields(active_only=False)
            return {"success": True, "fields": fields}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def save_field(self, field_key: str, label: str, display_order: int = 0) -> Dict[str, Any]:
        """إضافة حقل ديناميكي جديد (مدير النظام فقط)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        try:
            new_field = self._db.add_field(field_key, label, display_order)
            return {"success": True, "field": new_field, "message": "تمت إضافة الحقل الجديد بنجاح"}
        except Exception as e:
            return {"success": False, "error": f"تعذر إضافة الحقل: {str(e)}"}

    def toggle_field(self, field_id: int, is_active: int) -> Dict[str, Any]:
        """تفعيل أو إلغاء تفعيل حقل ديناميكي"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        try:
            success = self._db.toggle_field(field_id, is_active)
            return {"success": success}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def get_all_statuses(self) -> Dict[str, Any]:
        """جلب جميع الحالات الوظيفية"""
        try:
            statuses = self._db.get_statuses(active_only=False)
            return {"success": True, "statuses": statuses}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def save_status(self, name: str) -> Dict[str, Any]:
        """إضافة حالة وظيفية جديدة"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        try:
            res = self._db.add_status(name)
            return {"success": True, "status": res, "message": "تمت إضافة الحالة بنجاح"}
        except Exception as e:
            return {"success": False, "error": f"تعذر إضافة الحالة: {str(e)}"}

    def toggle_status(self, status_id: int, is_active: int) -> Dict[str, Any]:
        """تفعيل أو تعطيل حالة وظيفية"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        try:
            success = self._db.toggle_status(status_id, is_active)
            return {"success": success}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ==================== إدارة مستخدمي النظام والصلاحيات ====================

    def get_users_management(self) -> Dict[str, Any]:
        """جلب قائمة المستخدمين المفصلة مع الصلاحيات (مدير النظام فقط)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        try:
            users = self._db.get_users_detailed()
            return {"success": True, "users": users}
        except Exception as e:
            return {"success": False, "error": f"تعذر جلب قائمة المستخدمين: {str(e)}"}

    def save_user(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """إضافة أو تعديل مستخدم (مدير النظام فقط)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        user_id = data.get("id")
        display_name = str(data.get("display_name", "")).strip()
        pin_code = str(data.get("pin_code", "")).strip()
        role = str(data.get("role", "staff")).strip()

        try:
            if user_id:
                self._db.update_user(int(user_id), display_name, pin_code if pin_code else None, role)
                return {"success": True, "message": "تم تحديث بيانات المستخدم بنجاح"}
            else:
                new_u = self._db.add_user(display_name, pin_code, role)
                return {"success": True, "user": new_u, "message": "تمت إضافة المستخدم الجديد بنجاح"}
        except ValueError as ve:
            return {"success": False, "error": str(ve)}
        except Exception as e:
            return {"success": False, "error": f"حدث خطأ أثناء حفظ المستخدم: {str(e)}"}

    def delete_user(self, user_id: int) -> Dict[str, Any]:
        """حذف مستخدم من النظام (مدير النظام فقط)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        if self._current_user.get("id") == int(user_id):
            return {"success": False, "error": "لا يمكنك حذف حسابك الحالي الذي قمت بتسجيل الدخول به"}

        try:
            self._db.delete_user(int(user_id))
            return {"success": True, "message": "تم حذف المستخدم بنجاح"}
        except ValueError as ve:
            return {"success": False, "error": str(ve)}
        except Exception as e:
            return {"success": False, "error": f"تعذر حذف المستخدم: {str(e)}"}

    # ==================== تصدير واستيراد الإكسل ====================

    def export_excel(
        self,
        search_name: str = "",
        search_national_id: str = "",
        status_id: Optional[Any] = None,
        selected_ids: Optional[List[int]] = None
    ) -> Dict[str, Any]:
        """تصدير الموظفين المفلترين أو المحددين إلى ملف إكسل بعد فتح نافذة الحفظ للمستخدم"""
        if not self._window:
            return {"success": False, "error": "نافذة النظام غير متاحة"}

        try:
            # فتح نافذة حفظ الملفات
            timestamp = datetime.now().strftime("%Y-%m-%d_%H%M")
            default_filename = f"سجل_الموظفين_{timestamp}.xlsx"
            file_types = ("ملفات إكسل (*.xlsx)", "جميع الملفات (*.*)")
            save_path = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
                file_types=file_types
            )

            if not save_path:
                return {"success": False, "cancelled": True}

            if isinstance(save_path, (list, tuple)):
                save_path = save_path[0]

            if not save_path.lower().endswith(".xlsx"):
                save_path += ".xlsx"

            # جلب الموظفين
            status_filter = None
            if status_id not in (None, "", "all", 0, "0"):
                try:
                    status_filter = int(status_id)
                except ValueError:
                    pass

            employees = self._db.get_employees(
                search_name=search_name,
                search_national_id=search_national_id,
                status_id=status_filter
            )

            if selected_ids and len(selected_ids) > 0:
                selected_set = set(selected_ids)
                employees = [e for e in employees if e["id"] in selected_set]

            active_fields = self._db.get_fields(active_only=True)
            export_employees_to_excel(employees, active_fields, save_path)

            return {
                "success": True,
                "message": f"تم تصدير سجلات ({len(employees)}) موظف بنجاح إلى ملف الإكسل"
            }
        except Exception as e:
            return {"success": False, "error": f"تعذر إتمام تصدير الإكسل: {str(e)}"}

    def import_excel_browse_and_validate(self) -> Dict[str, Any]:
        """
        فتح متصفح الملفات لاختيار ملف إكسل وإجراء فحص التحقق الصارم واكتشاف التعارضات
        """
        if not self._window:
            return {"success": False, "error": "نافذة النظام غير متاحة"}

        try:
            file_types = ("ملفات إكسل (*.xlsx)",)
            selected_files = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=file_types
            )

            if not selected_files:
                return {"success": False, "cancelled": True}

            file_path = selected_files[0] if isinstance(selected_files, (list, tuple)) else selected_files

            # تشغيل الفحص والتحقق
            validation_result = parse_and_validate_excel_file(file_path, self._db)
            validation_result["file_path"] = file_path
            return validation_result

        except Exception as e:
            return {"success": False, "error": f"حدث خطأ أثناء قراءة ملف الإكسل: {str(e)}"}

    def import_excel_commit(
        self,
        new_records: List[Dict[str, Any]],
        resolved_conflicts: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """تنفيذ حفظ بيانات الاستيراد المعتمدة بعد معالجة خيارات التعارض"""
        try:
            result = execute_import_commit(new_records, resolved_conflicts, self._db)
            return result
        except Exception as e:
            return {"success": False, "error": f"تعذر تنفيذ الاستيراد: {str(e)}"}

    # ==================== تصدير مستندات وورد (Word .docx) ====================

    def export_word(
        self,
        report_type: str,
        selected_ids: List[int],
        selected_fields: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """تصدير الموظفين المحددين إلى مستند وورد منسق (بطاقات مستقلة أو كشف جدولي)"""
        if not self._window:
            return {"success": False, "error": "نافذة النظام غير متاحة"}

        if not selected_ids:
            return {"success": False, "error": "يرجى تحديد موظف واحد على الأقل للطباعة/التصدير"}

        try:
            timestamp = datetime.now().strftime("%Y-%m-%d_%H%M")
            if report_type == "cards":
                default_filename = f"بطاقات_الموظفين_{timestamp}.docx"
            else:
                default_filename = f"كشف_الموظفين_{timestamp}.docx"

            file_types = ("مستندات وورد (*.docx)", "جميع الملفات (*.*)")
            save_path = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
                file_types=file_types
            )

            if not save_path:
                return {"success": False, "cancelled": True}

            if isinstance(save_path, (list, tuple)):
                save_path = save_path[0]

            if not save_path.lower().endswith(".docx"):
                save_path += ".docx"

            # جلب بيانات الموظفين المحددين
            all_employees = self._db.get_employees()
            selected_set = set(selected_ids)
            chosen_employees = [e for e in all_employees if e["id"] in selected_set]
            # ترتيب الموظفين حسب التحديد
            chosen_employees.sort(key=lambda x: selected_ids.index(x["id"]) if x["id"] in selected_ids else 0)

            active_fields = self._db.get_fields(active_only=True)

            if report_type == "cards":
                export_word_employee_cards(chosen_employees, active_fields, selected_fields, save_path)
            else:
                export_word_employee_table(chosen_employees, active_fields, selected_fields, save_path)

            return {
                "success": True,
                "message": f"تم تصدير مستند الوورد بنجاح لعدد ({len(chosen_employees)}) موظف"
            }
        except Exception as e:
            return {"success": False, "error": f"تعذر تصدير ملف الوورد: {str(e)}"}

    # ==================== النسخ الاحتياطي والاسترجاع ====================

    def backup_database(self) -> Dict[str, Any]:
        """أخذ نسخة احتياطية من قاعدة البيانات وحفظها في المسار المختار (مدير النظام)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        if not self._window:
            return {"success": False, "error": "نافذة النظام غير متاحة"}

        try:
            today_str = datetime.now().strftime("%Y-%m-%d")
            default_filename = f"backup_employees_{today_str}.db"
            file_types = ("ملفات قاعدة البيانات (*.db)", "جميع الملفات (*.*)")

            dest_path = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_filename,
                file_types=file_types
            )

            if not dest_path:
                return {"success": False, "cancelled": True}

            if isinstance(dest_path, (list, tuple)):
                dest_path = dest_path[0]

            res = backup_database_to_file(self._db.db_path, dest_path)
            return res
        except Exception as e:
            return {"success": False, "error": f"فشل إنشاء النسخة الاحتياطية: {str(e)}"}

    def restore_database(self) -> Dict[str, Any]:
        """استرجاع قاعدة البيانات من ملف خارجي بعد فحص سلامة الهيكل (مدير النظام)"""
        if not self._current_user or self._current_user.get("role") != "admin":
            return {"success": False, "error": "عذراً، هذه العملية مخصصة لمدير النظام فقط"}

        if not self._window:
            return {"success": False, "error": "نافذة النظام غير متاحة"}

        try:
            file_types = ("ملفات قاعدة البيانات (*.db)",)
            selected_files = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=file_types
            )

            if not selected_files:
                return {"success": False, "cancelled": True}

            source_path = selected_files[0] if isinstance(selected_files, (list, tuple)) else selected_files

            res = restore_database_from_file(source_path, self._db.db_path)
            if res.get("success"):
                # إعادة تهيئة الاتصال بعد الاسترجاع
                self._db.init_db()
            return res
        except Exception as e:
            return {"success": False, "error": f"فشل استرجاع قاعدة البيانات: {str(e)}"}


def main():
    """الدالة الرئيسية لإطلاق نافذة التطبيق وسطح المكتب"""
    # تحديد مسار قاعدة البيانات بجوار البرنامج المحمول لضمان الحفظ الدائم
    base_dir = get_base_dir()
    db_path = os.path.join(base_dir, "database.db")
    db = Database(db_path=db_path)

    api = AppAPI(db=db)

    # تحديد مسار ملف HTML الرئيسي
    frontend_dir = get_frontend_dir()
    index_html = os.path.join(frontend_dir, "index.html")

    # استخدام مسار URI المعياري بدقة (file:///C:/...) لمنع أي تأخير في معالجة WebView2
    from pathlib import Path
    html_uri = Path(index_html).resolve().as_uri()

    # إنشاء النافذة المكتبية مع تفعيل Edge WebView2
    window = webview.create_window(
        title="نظام سجل الموظفين المحمول (SSS)",
        url=html_uri,
        js_api=api,
        width=1280,
        height=840,
        min_size=(1024, 700),
        background_color="#0F172A",
        text_select=True
    )

    api._set_window(window)

    # بدء دورة حياة واجهة المستخدم (تستخدم Edge WebView2 تلقائياً على ويندوز)
    webview.start(debug=False)


if __name__ == "__main__":
    main()
