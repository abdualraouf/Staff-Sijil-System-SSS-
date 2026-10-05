# -*- coding: utf-8 -*-
"""
وحدة إدارة وتكامل قاعدة البيانات SQLite
تتولى التهيئة، الهجرة التلقائية، وعمليات السجلات والحقول الديناميكية
"""

import os
import re
import json
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_DB_FILENAME = "database.db"

def get_default_db_path() -> str:
    """الحصول على المسار الافتراضي لقاعدة البيانات في نفس مجلد التطبيق الرئيسي"""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(current_dir, DEFAULT_DB_FILENAME)


class Database:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or get_default_db_path()
        self.init_db()

    def get_connection(self) -> sqlite3.Connection:
        """إنشاء اتصال مع قاعدة البيانات وتفعيل المفاتيح الأجنبية وتنسيق الصفوف كقواميس"""
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self) -> None:
        """تهيئة الجداول والبيانات الأولية عند الإقلاع"""
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # إنشاء جدول المستخدمين
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                display_name TEXT NOT NULL,
                pin_code TEXT NOT NULL,
                role TEXT CHECK(role IN ('admin', 'staff')) NOT NULL DEFAULT 'staff'
            );
            """)

            # إنشاء جدول الحالات الوظيفية
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS statuses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                is_active INTEGER NOT NULL DEFAULT 1
            );
            """)

            # إنشاء جدول تعريف الحقول المخصصة/الديناميكية
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS fields_definition (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                field_key TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                data_type TEXT NOT NULL DEFAULT 'text',
                min_length INTEGER DEFAULT NULL,
                max_length INTEGER DEFAULT NULL,
                options TEXT DEFAULT NULL,
                default_value TEXT DEFAULT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                is_system INTEGER NOT NULL DEFAULT 0,
                display_order INTEGER NOT NULL DEFAULT 0
            );
            """)

            # التحقق من وجود الأعمدة وترقيتها تلقائياً في حال وجود قاعدة بيانات مسبقة
            cursor.execute("PRAGMA table_info(fields_definition);")
            existing_cols = {col[1] for col in cursor.fetchall()}
            if "data_type" not in existing_cols:
                cursor.execute("ALTER TABLE fields_definition ADD COLUMN data_type TEXT NOT NULL DEFAULT 'text';")
            if "min_length" not in existing_cols:
                cursor.execute("ALTER TABLE fields_definition ADD COLUMN min_length INTEGER DEFAULT NULL;")
            if "max_length" not in existing_cols:
                cursor.execute("ALTER TABLE fields_definition ADD COLUMN max_length INTEGER DEFAULT NULL;")
            if "options" not in existing_cols:
                cursor.execute("ALTER TABLE fields_definition ADD COLUMN options TEXT DEFAULT NULL;")
            if "default_value" not in existing_cols:
                cursor.execute("ALTER TABLE fields_definition ADD COLUMN default_value TEXT DEFAULT NULL;")
            if "is_system" not in existing_cols:
                cursor.execute("ALTER TABLE fields_definition ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;")

            # إنشاء جدول الموظفين
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS employees (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                national_id TEXT NOT NULL UNIQUE,
                full_name TEXT NOT NULL,
                status_id INTEGER NOT NULL,
                hire_date TEXT,
                department TEXT,
                current_grade TEXT,
                grade_date TEXT,
                education_level TEXT,
                specialization TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(status_id) REFERENCES statuses(id) ON UPDATE CASCADE
            );
            """)

            # إنشاء جدول قيم الحقول الديناميكية للموظفين
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS employee_field_values (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id INTEGER NOT NULL,
                field_id INTEGER NOT NULL,
                field_value TEXT,
                FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
                FOREIGN KEY(field_id) REFERENCES fields_definition(id) ON DELETE CASCADE,
                UNIQUE(employee_id, field_id)
            );
            """)

            # إدخال الحالات الوظيفية الافتراضية إذا كان الجدول فارغاً
            cursor.execute("SELECT COUNT(*) FROM statuses;")
            if cursor.fetchone()[0] == 0:
                default_statuses = [
                    ("على رأس العمل", 1),
                    ("إجازة خاصة", 1),
                    ("منتدب", 1),
                    ("منقطع", 1),
                    ("متقاعد", 1)
                ]
                cursor.executemany("INSERT INTO statuses (name, is_active) VALUES (?, ?);", default_statuses)

            # إدخال المستخدمين الافتراضيين إذا كان الجدول فارغاً
            cursor.execute("SELECT COUNT(*) FROM users;")
            if cursor.fetchone()[0] == 0:
                default_users = [
                    ("مدير النظام", "1234", "admin"),
                    ("موظف الإدخال", "0000", "staff")
                ]
                cursor.executemany("INSERT INTO users (display_name, pin_code, role) VALUES (?, ?, ?);", default_users)

            # إدخال وترقية الحقول الأساسية للنظام
            core_fields = [
                ("national_id", "الرقم الوطني", "number", 12, 12, "", "", 1, 1, 1),
                ("full_name", "الاسم الكامل", "text", 3, 100, "", "", 1, 1, 2),
                ("status_id", "الحالة الوظيفية", "select", None, None, "", "1", 1, 1, 3),
                ("department", "القسم / الإدارة", "text", None, None, "", "", 1, 0, 4),
                ("current_grade", "الدرجة الحالية", "text", None, None, "", "", 1, 0, 5),
                ("education_level", "المؤهل العلمي", "text", None, None, "", "", 1, 0, 6),
                ("hire_date", "تاريخ التعيين", "date", None, None, "", "", 1, 0, 7),
                ("grade_date", "تاريخ استحقاق الدرجة", "date", None, None, "", "", 1, 0, 8),
                ("specialization", "التخصص العلمي", "text", None, None, "", "", 1, 0, 9),
            ]
            for f_key, f_lbl, f_type, f_min, f_max, f_opt, f_def, f_act, f_sys, f_ord in core_fields:
                cursor.execute("SELECT id FROM fields_definition WHERE field_key = ?;", (f_key,))
                existing_f = cursor.fetchone()
                if not existing_f:
                    cursor.execute("""
                        INSERT INTO fields_definition 
                        (field_key, label, data_type, min_length, max_length, options, default_value, is_active, is_system, display_order)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                    """, (f_key, f_lbl, f_type, f_min, f_max, f_opt, f_def, f_act, f_sys, f_ord))
                else:
                    if f_sys == 1:
                        cursor.execute("UPDATE fields_definition SET is_system = 1 WHERE id = ?;", (existing_f[0],))

            conn.commit()

            # ضمان وجود خيارات الحالة الوظيفية الافتراضية في fields_definition
            cursor.execute("SELECT id, options FROM fields_definition WHERE field_key = 'status_id';")
            st_field = cursor.fetchone()
            if st_field and not st_field["options"]:
                cursor.execute("SELECT name FROM statuses WHERE is_active = 1 ORDER BY id ASC;")
                status_names = [row["name"] for row in cursor.fetchall()]
                if status_names:
                    cursor.execute("UPDATE fields_definition SET options = ? WHERE id = ?;", ("، ".join(status_names), st_field["id"]))
                    conn.commit()

    # ==================== إدارة الجلسات والمستخدمين ====================

    def get_users(self) -> List[Dict[str, Any]]:
        """جلب قائمة المستخدمين المعرفين لاختيارهم في شاشة الدخول"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, display_name, role FROM users ORDER BY id ASC;")
            return [dict(row) for row in cursor.fetchall()]

    def authenticate_user(self, user_id: int, pin_code: str) -> Optional[Dict[str, Any]]:
        """التحقق من صحة رمز المرور (PIN) للمستخدم المختار"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, display_name, role FROM users WHERE id = ? AND pin_code = ?;",
                (user_id, str(pin_code).strip())
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_users_detailed(self) -> List[Dict[str, Any]]:
        """جلب قائمة المستخدمين المفصلة لإدارتها من قبل مدير النظام"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, display_name, role, pin_code FROM users ORDER BY id ASC;")
            return [dict(row) for row in cursor.fetchall()]

    def add_user(self, display_name: str, pin_code: str, role: str = "staff") -> Dict[str, Any]:
        """إضافة مستخدم جديد للنظام مع التحقق من صحة البيانات"""
        display_name = display_name.strip()
        pin_code = str(pin_code).strip()
        if not display_name:
            raise ValueError("اسم المستخدم مطلوب")
        if not pin_code or len(pin_code) < 3:
            raise ValueError("رمز المرور (PIN) يجب ألا يقل عن 3 أرقام")
        if role not in ("admin", "staff"):
            role = "staff"

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO users (display_name, pin_code, role) VALUES (?, ?, ?);",
                (display_name, pin_code, role)
            )
            new_id = cursor.lastrowid
            conn.commit()
            return {"id": new_id, "display_name": display_name, "role": role}

    def update_user(self, user_id: int, display_name: str, pin_code: Optional[str] = None, role: str = "staff") -> bool:
        """تحديث بيانات مستخدم حالي"""
        display_name = display_name.strip()
        if not display_name:
            raise ValueError("اسم المستخدم مطلوب")
        if role not in ("admin", "staff"):
            role = "staff"

        with self.get_connection() as conn:
            cursor = conn.cursor()
            if pin_code and str(pin_code).strip():
                clean_pin = str(pin_code).strip()
                cursor.execute(
                    "UPDATE users SET display_name = ?, pin_code = ?, role = ? WHERE id = ?;",
                    (display_name, clean_pin, role, user_id)
                )
            else:
                cursor.execute(
                    "UPDATE users SET display_name = ?, role = ? WHERE id = ?;",
                    (display_name, role, user_id)
                )
            conn.commit()
            return cursor.rowcount > 0

    def delete_user(self, user_id: int) -> bool:
        """حذف مستخدم من النظام مع منع حذف آخر مدير نظام"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # فحص ما إذا كان المستخدم المستهدف مديراً
            cursor.execute("SELECT role FROM users WHERE id = ?;", (user_id,))
            target = cursor.fetchone()
            if not target:
                raise ValueError("المستخدم غير موجود")

            if target["role"] == "admin":
                # التأكد من وجود مدير آخر على الأقل
                cursor.execute("SELECT COUNT(*) FROM users WHERE role = 'admin';")
                admin_count = cursor.fetchone()[0]
                if admin_count <= 1:
                    raise ValueError("لا يمكن حذف مدير النظام الوحيد؛ يجب أن يبقى مدير نظام واحد على الأقل")

            cursor.execute("DELETE FROM users WHERE id = ?;", (user_id,))
            conn.commit()
            return cursor.rowcount > 0

    # ==================== إدارة الحالات والحقول الديناميكية ====================

    def get_statuses(self, active_only: bool = False) -> List[Dict[str, Any]]:
        """جلب جميع الحالات الوظيفية"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if active_only:
                cursor.execute("SELECT * FROM statuses WHERE is_active = 1 ORDER BY id ASC;")
            else:
                cursor.execute("SELECT * FROM statuses ORDER BY id ASC;")
            return [dict(row) for row in cursor.fetchall()]

    def add_status(self, name: str) -> Dict[str, Any]:
        """إضافة حالة وظيفية جديدة"""
        name = name.strip()
        if not name:
            raise ValueError("اسم الحالة مطلوب")
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT INTO statuses (name, is_active) VALUES (?, 1);", (name,))
            new_id = cursor.lastrowid
            conn.commit()
            return {"id": new_id, "name": name, "is_active": 1}

    def toggle_status(self, status_id: int, is_active: int) -> bool:
        """تفعيل أو تعطيل حالة وظيفية"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE statuses SET is_active = ? WHERE id = ?;", (1 if is_active else 0, status_id))
            conn.commit()
            return cursor.rowcount > 0

    def get_fields(self, active_only: bool = False) -> List[Dict[str, Any]]:
        """جلب الحقول مرتبة حسب display_order ثم id مع ضمان وجود خيارات الحالة الوظيفية"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            query = "SELECT * FROM fields_definition"
            if active_only:
                query += " WHERE is_active = 1"
            query += " ORDER BY display_order ASC, id ASC;"
            cursor.execute(query)
            fields = [dict(row) for row in cursor.fetchall()]
            for f in fields:
                if f.get("field_key") == "status_id" and not f.get("options"):
                    cursor.execute("SELECT name FROM statuses WHERE is_active = 1 ORDER BY id ASC;")
                    names = [r["name"] for r in cursor.fetchall()]
                    f["options"] = "، ".join(names)
            return fields

    def add_field(
        self,
        field_key: str,
        label: str,
        display_order: int = 0,
        data_type: str = "text",
        min_length: Optional[int] = None,
        max_length: Optional[int] = None,
        options: str = "",
        default_value: str = ""
    ) -> Dict[str, Any]:
        """إضافة حقل جديد للنظام مع كامل خصائصه"""
        field_key = field_key.strip().lower()
        label = label.strip()
        if not field_key or not label:
            raise ValueError("مفتاح الحقل والتسمية مطلوبان")

        if not re.match(r'^[a-z0-9_]+$', field_key):
            raise ValueError("مفتاح الحقل يجب أن يتكون من أحرف إنجليزية وأرقام وشرطة سفلية فقط (_) بدون مسافات")

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM fields_definition WHERE field_key = ?;", (field_key,))
            if cursor.fetchone():
                raise ValueError(f"مفتاح الحقل [{field_key}] مسجل مسبقاً")

            cursor.execute("""
                INSERT INTO fields_definition 
                (field_key, label, data_type, min_length, max_length, options, default_value, is_active, is_system, display_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?);
            """, (field_key, label, data_type, min_length, max_length, options, default_value, display_order))
            new_id = cursor.lastrowid
            conn.commit()
            return {
                "id": new_id,
                "field_key": field_key,
                "label": label,
                "data_type": data_type,
                "min_length": min_length,
                "max_length": max_length,
                "options": options,
                "default_value": default_value,
                "is_active": 1,
                "is_system": 0,
                "display_order": display_order
            }

    def save_field(self, field_data: Dict[str, Any]) -> Dict[str, Any]:
        """إضافة أو تعديل خصائص حقل"""
        field_id = field_data.get("id")
        field_key = str(field_data.get("field_key", "")).strip().lower()
        label = str(field_data.get("label", "")).strip()
        data_type = str(field_data.get("data_type", "text")).strip().lower() or "text"
        min_length = field_data.get("min_length")
        max_length = field_data.get("max_length")
        options = str(field_data.get("options", "")).strip()
        default_value = str(field_data.get("default_value", "")).strip()
        display_order = int(field_data.get("display_order", 0))

        if min_length not in (None, ""):
            try: min_length = int(min_length)
            except ValueError: min_length = None
        else: min_length = None

        if max_length not in (None, ""):
            try: max_length = int(max_length)
            except ValueError: max_length = None
        else: max_length = None

        if not label:
            raise ValueError("تسمية الحقل مطلوبة")

        with self.get_connection() as conn:
            cursor = conn.cursor()

            if field_id:
                cursor.execute("SELECT * FROM fields_definition WHERE id = ?;", (field_id,))
                existing = cursor.fetchone()
                if not existing:
                    raise ValueError("الحقل المطلوب تعديله غير موجود")

                is_sys = existing["is_system"]
                actual_key = existing["field_key"]

                # الحقول الأساسية المحمية لا يمكن تعديل مفتاحها
                if is_sys == 1:
                    field_key = actual_key
                elif field_key and field_key != actual_key:
                    cursor.execute("SELECT id FROM fields_definition WHERE field_key = ? AND id != ?;", (field_key, field_id))
                    if cursor.fetchone():
                        raise ValueError(f"مفتاح الحقل [{field_key}] مسجل مسبقاً")

                # عند تعديل حقل الحالة الوظيفية، مزامنة الخيارات مع جدول الحالات
                if field_key == "status_id":
                    if options:
                        status_names = [s.strip() for s in re.split(r'[,،\n]', options) if s.strip()]
                        if status_names:
                            for s_name in status_names:
                                cursor.execute("SELECT id FROM statuses WHERE name = ?;", (s_name,))
                                row = cursor.fetchone()
                                if row:
                                    cursor.execute("UPDATE statuses SET is_active = 1 WHERE id = ?;", (row["id"],))
                                else:
                                    cursor.execute("INSERT INTO statuses (name, is_active) VALUES (?, 1);", (s_name,))

                            placeholders = ",".join("?" for _ in status_names)
                            cursor.execute(f"UPDATE statuses SET is_active = 0 WHERE name NOT IN ({placeholders});", status_names)
                            options = "، ".join(status_names)

                    if default_value:
                        if str(default_value).isdigit():
                            cursor.execute("SELECT id FROM statuses WHERE id = ?;", (int(default_value),))
                            if not cursor.fetchone():
                                cursor.execute("SELECT id FROM statuses WHERE name = ?;", (str(default_value),))
                                r = cursor.fetchone()
                                if r: default_value = str(r["id"])
                        else:
                            cursor.execute("SELECT id FROM statuses WHERE name = ?;", (str(default_value),))
                            r = cursor.fetchone()
                            if r: default_value = str(r["id"])

                cursor.execute("""
                    UPDATE fields_definition
                    SET field_key = ?,
                        label = ?,
                        data_type = ?,
                        min_length = ?,
                        max_length = ?,
                        options = ?,
                        default_value = ?,
                        display_order = ?
                    WHERE id = ?;
                """, (field_key, label, data_type, min_length, max_length, options, default_value, display_order, field_id))
                conn.commit()
                return {"id": field_id, "field_key": field_key, "label": label, "data_type": data_type, "display_order": display_order}
            else:
                return self.add_field(
                    field_key=field_key,
                    label=label,
                    display_order=display_order,
                    data_type=data_type,
                    min_length=min_length,
                    max_length=max_length,
                    options=options,
                    default_value=default_value
                )

    def delete_field(self, field_id: int) -> bool:
        """حذف حقل ديناميكي مع منع حذف الحقول الأساسية المحمية (الرقم الوطني والاسم الكامل)"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM fields_definition WHERE id = ?;", (field_id,))
            f = cursor.fetchone()
            if not f:
                return False

            if f["is_system"] == 1 or f["field_key"] in ("national_id", "full_name"):
                raise ValueError(f"عذراً، لا يمكن حذف الحقل الأساسي [{f['label']}] لأنه حقل جوهري للمنظومة")

            cursor.execute("DELETE FROM employee_field_values WHERE field_id = ?;", (field_id,))
            cursor.execute("DELETE FROM fields_definition WHERE id = ?;", (field_id,))
            conn.commit()
            return cursor.rowcount > 0

    def toggle_field(self, field_id: int, is_active: int) -> bool:
        """تفعيل أو تعطيل حقل مع منع تعطيل الحقول الأساسية"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM fields_definition WHERE id = ?;", (field_id,))
            f = cursor.fetchone()
            if not f:
                return False

            if (f["is_system"] == 1 or f["field_key"] in ("national_id", "full_name")) and is_active == 0:
                raise ValueError(f"لا يمكن تعطيل الحقل الأساسي [{f['label']}]")

            cursor.execute("UPDATE fields_definition SET is_active = ? WHERE id = ?;", (1 if is_active else 0, field_id))
            conn.commit()
            return cursor.rowcount > 0

    # ==================== إدارة الموظفين ====================

    def check_national_id_exists(self, national_id: str, exclude_id: Optional[int] = None) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """فحص ما إذا كان الرقم الوطني مسجلاً مسبقاً لموظف آخر"""
        national_id = str(national_id).strip()
        if not national_id:
            return False, None
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if exclude_id is not None:
                cursor.execute("SELECT id, national_id, full_name FROM employees WHERE national_id = ? AND id != ?;", (national_id, exclude_id))
            else:
                cursor.execute("SELECT id, national_id, full_name FROM employees WHERE national_id = ?;", (national_id,))
            row = cursor.fetchone()
            if row:
                return True, dict(row)
            return False, None

    def get_employee(self, emp_id: int) -> Optional[Dict[str, Any]]:
        """جلب بيانات موظف محدد مع كافة قيمه في الحقول المخصصة"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT e.*, s.name as status_name
                FROM employees e
                LEFT JOIN statuses s ON e.status_id = s.id
                WHERE e.id = ?;
            """, (emp_id,))
            emp_row = cursor.fetchone()
            if not emp_row:
                return None

            emp_data = dict(emp_row)

            # جلب قيم الحقول المخصصة غير الأساسية
            cursor.execute("""
                SELECT f.id as field_id, f.field_key, f.label, v.field_value
                FROM fields_definition f
                LEFT JOIN employee_field_values v ON f.id = v.field_id AND v.employee_id = ?
                WHERE f.is_active = 1 
                  AND f.field_key NOT IN ('national_id', 'full_name', 'status_id', 'hire_date', 'department', 'current_grade', 'grade_date', 'education_level', 'specialization')
                ORDER BY f.display_order ASC, f.id ASC;
            """, (emp_id,))
            custom_values = {}
            custom_list = []
            for r in cursor.fetchall():
                row_dict = dict(r)
                custom_values[row_dict["field_key"]] = row_dict["field_value"] or ""
                custom_list.append(row_dict)

            emp_data["custom_values"] = custom_values
            emp_data["custom_fields_detail"] = custom_list
            return emp_data

    def get_employees(
        self,
        search_name: str = "",
        search_national_id: str = "",
        status_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """جلب الموظفين وفق شروط البحث والفلترة"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            query = """
                SELECT e.*, s.name as status_name
                FROM employees e
                LEFT JOIN statuses s ON e.status_id = s.id
                WHERE 1=1
            """
            params = []

            if search_name and search_name.strip():
                query += " AND e.full_name LIKE ?"
                params.append(f"%{search_name.strip()}%")

            if search_national_id and search_national_id.strip():
                query += " AND e.national_id LIKE ?"
                params.append(f"%{search_national_id.strip()}%")

            if status_id is not None and str(status_id).strip() != "":
                try:
                    s_id = int(status_id)
                    if s_id > 0:
                        query += " AND e.status_id = ?"
                        params.append(s_id)
                except ValueError:
                    pass

            query += " ORDER BY e.id DESC;"
            cursor.execute(query, params)
            employees = [dict(row) for row in cursor.fetchall()]

            # جلب كافة الحقول المخصصة النشطة (غير أعمدة جدول employees الأساسية)
            cursor.execute("""
                SELECT id, field_key FROM fields_definition 
                WHERE is_active = 1 
                  AND field_key NOT IN ('national_id', 'full_name', 'status_id', 'hire_date', 'department', 'current_grade', 'grade_date', 'education_level', 'specialization');
            """)
            active_fields = cursor.fetchall()

            if employees and active_fields:
                emp_ids = [e["id"] for e in employees]
                placeholders = ",".join("?" for _ in emp_ids)
                cursor.execute(f"""
                    SELECT employee_id, field_id, field_value
                    FROM employee_field_values
                    WHERE employee_id IN ({placeholders});
                """, emp_ids)
                all_values = cursor.fetchall()

                # هيكلة القيم حسب الموظف
                val_map = {}
                for v in all_values:
                    emp_i = v["employee_id"]
                    if emp_i not in val_map:
                        val_map[emp_i] = {}
                    val_map[emp_i][v["field_id"]] = v["field_value"]

                field_id_to_key = {f["id"]: f["field_key"] for f in active_fields}

                for emp in employees:
                    emp_custom = {}
                    e_vals = val_map.get(emp["id"], {})
                    for fid, fkey in field_id_to_key.items():
                        emp_custom[fkey] = e_vals.get(fid, "") or ""
                    emp["custom_values"] = emp_custom
            else:
                for emp in employees:
                    emp["custom_values"] = {}

            return employees

    def save_employee(self, data: Dict[str, Any], custom_values: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """إضافة موظف جديد أو تحديث موظف حالي مع حفظ قيمه الديناميكية داخل معاملة واحدة"""
        emp_id = data.get("id")
        national_id = str(data.get("national_id", "")).strip()
        full_name = str(data.get("full_name", "")).strip()
        status_id = data.get("status_id")
        hire_date = str(data.get("hire_date", "")).strip() or None
        department = str(data.get("department", "")).strip() or None
        current_grade = str(data.get("current_grade", "")).strip() or None
        grade_date = str(data.get("grade_date", "")).strip() or None
        education_level = str(data.get("education_level", "")).strip() or None
        specialization = str(data.get("specialization", "")).strip() or None

        if not national_id:
            raise ValueError("الرقم الوطني مطلوب")
        if not full_name:
            raise ValueError("الاسم الكامل مطلوب")
        if not status_id:
            raise ValueError("الحالة الوظيفية مطلوبة")

        # فحص تكرار الرقم الوطني
        exists, existing = self.check_national_id_exists(national_id, exclude_id=emp_id)
        if exists:
            raise ValueError(f"الرقم الوطني ({national_id}) مسجل مسبقاً باسم {existing['full_name']}")

        # التحقق من القيود المحددة للحقول (الحد الأدنى والأقصى للحروف)
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM fields_definition WHERE is_active = 1;")
            active_defs = {r["field_key"]: dict(r) for r in cursor.fetchall()}

        all_incoming = dict(data)
        if custom_values:
            all_incoming.update(custom_values)

        for fkey, fdef in active_defs.items():
            if fkey in all_incoming:
                val = all_incoming[fkey]
                if val is not None:
                    val_str = str(val).strip()
                    if val_str:
                        min_len = fdef.get("min_length")
                        max_len = fdef.get("max_length")
                        if min_len is not None and len(val_str) < min_len:
                            raise ValueError(f"قيمة حقل [{fdef['label']}] يجب ألا تقل عن ({min_len}) حرف/رقم")
                        if max_len is not None and len(val_str) > max_len:
                            raise ValueError(f"قيمة حقل [{fdef['label']}] يجب ألا تزيد عن ({max_len}) حرف/رقم")

        with self.get_connection() as conn:
            cursor = conn.cursor()

            if emp_id:
                # تحديث الموظف
                cursor.execute("""
                    UPDATE employees
                    SET national_id = ?,
                        full_name = ?,
                        status_id = ?,
                        hire_date = ?,
                        department = ?,
                        current_grade = ?,
                        grade_date = ?,
                        education_level = ?,
                        specialization = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?;
                """, (
                    national_id, full_name, status_id, hire_date, department,
                    current_grade, grade_date, education_level, specialization, emp_id
                ))
            else:
                # إنشاء موظف جديد
                cursor.execute("""
                    INSERT INTO employees (
                        national_id, full_name, status_id, hire_date, department,
                        current_grade, grade_date, education_level, specialization,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
                """, (
                    national_id, full_name, status_id, hire_date, department,
                    current_grade, grade_date, education_level, specialization
                ))
                emp_id = cursor.lastrowid

            # حفظ الحقول المخصصة إذا تم تمريرها (باستثناء أعمدة الجدول الأساسية)
            if custom_values is not None:
                cursor.execute("""
                    SELECT id, field_key FROM fields_definition 
                    WHERE is_active = 1 
                      AND field_key NOT IN ('national_id', 'full_name', 'status_id', 'hire_date', 'department', 'current_grade', 'grade_date', 'education_level', 'specialization');
                """)
                active_fields = cursor.fetchall()
                for af in active_fields:
                    fid = af["id"]
                    fkey = af["field_key"]
                    fval = str(custom_values.get(fkey, "")).strip()

                    cursor.execute("""
                        INSERT INTO employee_field_values (employee_id, field_id, field_value)
                        VALUES (?, ?, ?)
                        ON CONFLICT(employee_id, field_id) DO UPDATE SET field_value = excluded.field_value;
                    """, (emp_id, fid, fval))

            conn.commit()
            return {"id": emp_id, "national_id": national_id, "full_name": full_name}

    def update_employee_status(self, emp_id: int, status_id: int) -> bool:
        """تعديل الحالة الوظيفية للموظف (كالحذف الروتيني بالتحويل إلى منقطع أو متقاعد)"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE employees
                SET status_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?;
            """, (status_id, emp_id))
            conn.commit()
            return cursor.rowcount > 0

    def delete_employee_permanent(self, emp_id: int) -> bool:
        """الحذف النهائي من قاعدة البيانات (صلاحية مدير النظام فقط)"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM employees WHERE id = ?;", (emp_id,))
            conn.commit()
            return cursor.rowcount > 0

    def delete_employees_batch(self, emp_ids: List[int]) -> int:
        """حذف مجموعة من الموظفين دفعة واحدة من قاعدة البيانات (صلاحية مدير النظام فقط)"""
        if not emp_ids:
            return 0
        with self.get_connection() as conn:
            cursor = conn.cursor()
            placeholders = ",".join("?" for _ in emp_ids)
            cursor.execute(f"DELETE FROM employees WHERE id IN ({placeholders});", tuple(emp_ids))
            conn.commit()
            return cursor.rowcount

    # ==================== التحقق من سلامة قاعدة البيانات للنسخ الاحتياطي ====================

    @staticmethod
    def validate_database_file(file_path: str) -> bool:
        """التحقق من أن ملف قاعدة البيانات صالح ويحتوي على كافة الجداول الرئيسية"""
        if not os.path.exists(file_path):
            return False
        try:
            conn = sqlite3.connect(file_path)
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = {row[0] for row in cursor.fetchall()}
            conn.close()
            required_tables = {"users", "statuses", "fields_definition", "employees", "employee_field_values"}
            return required_tables.issubset(tables)
        except Exception:
            return False
