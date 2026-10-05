# خطة العمل: تجميع النظام كملف تشغيلي واحد مستقل (.exe) مع حماية التحديثات

تهدف هذه الخطة إلى تحويل **نظام سجل الموظفين المحمول (Staff Sijil System - SSS)** من صورته الحالية المعتمدة على سكربتات بايثون المتعددة إلى **ملف تنفيذي واحد ومستقل بالكامل (`StaffSijilSystem.exe`)**. يتضمن الملف كافة حزم بايثون، ومحرك العرض، وواجهة المستخدم، مع تطبيق منظومة أمان متقدمة تمنع الكتابة فوق قاعدة البيانات الحالية أو فقدانها عند استبدال البرنامج بنسخة أحدث.

---

## 1. أهداف التطوير والمخرجات الأساسية (Goal Description)

1. **ملف تشغيلي وحيد وشامل (`PyInstaller --onefile`)**:
   - دمج محرك بايثون، وواجهة المستخدم (`frontend/`)، والمكتبات الخارجية (`pywebview`، `openpyxl`، `python-docx`) في ملف تنفيذي واحد (`StaffSijilSystem.exe`).
   - تشغيل الملف فورياً بالنقر المزدوج دون الحاجة لتثبيت أي برامج أو حزم على جهاز المستخدم، ومع إخفاء تام للنافذة الطرفية السوداء (No Console).
2. **منظومة حماية البيانات وعدم الاستبدال (Zero-Loss / Anti-Overwrite Architecture)**:
   - فصل الملفات التنفيذية القابلة للتحديث عن مسار قاعدة البيانات الدائمة.
   - إنشاء مجلد منظم للبيانات (`data/`) ومجلد للنسخ الاحتياطية الوقائية (`backups/`) بجوار الملف التنفيذي تلقائياً.
   - **آلية النسخ الاحتياطي التلقائي عند الإقلاع (Auto-Backup on Startup)**: عند إطلاق أي إصدار جديد من البرنامج، يتم فحص قاعدة البيانات السابقة وعمل نسخة احتياطية فورية ومؤرخة منها قبل بدء أي عملية، مما يمنع نهائياً فقدان البيانات إذا قام المستخدم بتحديث البرنامج عبر واتساب أو فلاشة.
3. **الهوية البصرية والأيقونة الإدارية (Brand Identity & Official Icon)**:
   - تصميم وتوليد أيقونة رسمية إدارية متعددة الأحجام (`app_icon.ico`) لحفظ الهوية المؤسسية للملف التنفيذي على ويندوز.
4. **حزمة التثبيت الذكية الاختيارية (Inno Setup Script)**:
   - إعداد سكربت برمجي لتوليد برنامج تثبيت وترقية ذكي (`Setup.exe`) يثبت البرنامج ويُنشئ اختصارات سطح المكتب، ويحظر استبدال ملف البيانات عند الترقية عبر وسم `onlyifdestfiledoesntexist`.

---

## 2. متطلبات المراجعة مع المستخدم (User Review Required)

> [!IMPORTANT]
> **هيكل المجلدات عند التشغيل المحمول:**
> عند تشغيل `StaffSijilSystem.exe` لأول مرة على سطح المكتب أو على وحدة تخزين خارجية (Flash Drive)، سيقوم البرنامج تلقائياً بإنشاء مجلدين منظمين بجواره:
> - مجلد `data/`: يحتوي على قاعدة البيانات الدائمة `database.db`.
> - مجلد `backups/`: يحتوي على النسخ الاحتياطية الآلية التي تؤخذ تلقائياً قبل كل تشغيل أو ترقية لضمان الأمان التام.
> إذا رغبت مستقبلاً في جعل ملف قاعدة البيانات يظهر مباشرة بجوار الملف التنفيذي دون مجلد `data/`، يمكن ذلك بتعديل متغير واحد فقط.

> [!NOTE]
> **محرك العرض (Microsoft Edge WebView2):**
> يتوفر محرك WebView2 تلقائياً ومسبقاً على جميع أنظمة Windows 10 الحديثة و Windows 11. سيقوم كود الإقلاع بالتحقق الذاتي من توفر المحرك وعرض رسالة إرشادية آمنة للمستخدم في حال تشغيله على أنظمة ويندوز قديمة جداً تفتقر للمحرك.

---

## 3. التعديلات البرمجية المقترحة (Proposed Changes)

```
Staff-Sijil-System-SSS-/
├── employee_system/
│   ├── main.py                     # [MODIFY] دعم مسار البيانات المنفصل والنسخ الوقائي عند الإقلاع
│   ├── database.py                 # [MODIFY] دعم مسار المجلد data والتحقق الآمن من الجداول
│   ├── app_icon.ico                # [NEW] أيقونة النظام الإدارية الرسمية
│   ├── generate_icon.py            # [NEW] سكربت مساعد لتوليد الأيقونة متعددة الأحجام
│   ├── build_single_exe.bat        # [NEW] سكربت بناء الملف التنفيذي الموحد --onefile
│   └── installer_script.iss        # [NEW] سكربت تجهيز برنامج التثبيت الذكي Inno Setup
```

---

### أ. طبقة الإقلاع والتحقق: `employee_system/main.py`
- تحديث دالة `get_base_dir()` لتعيد بدقة مسار مجلد الملف التنفيذي الحقيقي عند التجميع عبر `getattr(sys, 'frozen', False)`.
- إضافة دالة `ensure_app_directories_and_backup()`:
  - التحقق من وجود مجلد `data/` ومجلد `backups/`.
  - إذا وُجدت قاعدة بيانات سابقة `data/database.db`، تؤخذ منها نسخة احتياطية فورية تحمل التاريخ والوقت (مثل: `backups/auto_backup_2026-10-05_143000.db`).
  - تطبيق سياسة تدوير النسخ الاحتياطية (Retention Policy) للاحتفاظ بآخر 10 نسخ وقائية وتفادي استهلاك المساحة.

```python
def ensure_app_storage_and_backup(base_dir: str) -> str:
    data_dir = os.path.join(base_dir, "data")
    backups_dir = os.path.join(base_dir, "backups")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(backups_dir, exist_ok=True)
    
    db_path = os.path.join(data_dir, "database.db")
    
    # حماية البيانات من الكتابة الفوقية عند الترقية بأخذ نسخة وقائية فورية
    if os.path.exists(db_path) and os.path.getsize(db_path) > 0:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        backup_name = f"auto_safety_backup_{timestamp}.db"
        dest_backup = os.path.join(backups_dir, backup_name)
        try:
            backup_database_to_file(db_path, dest_backup)
            # الإبقاء على أحدث 10 نسخ وقائية فقط
            _prune_old_backups(backups_dir, max_keep=10)
        except Exception as e:
            print(f"Warning: safety backup failed: {e}")
            
    return db_path
```

---

### ب. الهوية البصرية وتوليد الأيقونة: `employee_system/generate_icon.py`
- كتابة سكربت بايثون مخصص يقوم بإنشاء أيقونة نظام رسمية عالية الدقة (`app_icon.ico`) تضم الطبقات القياسية لبيئة ويندوز:
  - أحجام: `(16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256)`.
  - مظهر يحمل الهوية المؤسسية (سجل إداري موثوق بدرجات الكحلي والذهبي الهادئ).

---

### ج. سكربت البناء الموحد: `employee_system/build_single_exe.bat`
- إعداد أمر البناء الصارم عبر `PyInstaller`:
```bat
pyinstaller --noconsole --onefile ^
  --icon="app_icon.ico" ^
  --add-data "frontend;frontend" ^
  --add-data "app_icon.ico;." ^
  --name "StaffSijilSystem" ^
  --clean ^
  main.py
```
- ضمان استخراج واجهة المستخدم بسلاسة من المجلد المؤقت الداخلي `sys._MEIPASS` مع توجيه قاعدة البيانات إلى مجلد التنفيذ الخارجي الحقيقي.

---

### د. سكريبت التثبيت الذكي: `employee_system/installer_script.iss`
- تجهيز ملف إعدادات Inno Setup الجاهز للتجميع ليسمح لاحقاً ببناء حزمة تثبيت `Setup.exe`:
  - يتضمن تعليمات صريحة لحماية البيانات:
    `Source: "data\database.db"; DestDir: "{app}\data"; Flags: onlyifdestfiledoesntexist uninsneveruninstall`
  - إنشاء اختصارات في قائمة ابدأ وسطح المكتب.

---

## 4. خطة الفحص والتحقق (Verification Plan)

### أولاً: الفحص الآلي للمكتبات وقاعدة البيانات (Automated Tests)
1. تثبيت المتطلبات (`pyinstaller`, `pywebview`, `openpyxl`).
2. تشغيل جناح الاختبارات الآلي الشامل للتأكد من سلامة النظام 100%:
   ```powershell
   python employee_system/test_system.py
   ```
3. تنفيذ سكربت توليد الأيقونة والتأكد من صحة ترويسة ملف `.ico`.

### ثانياً: بناء الملف التنفيذي والتحقق من النتيجة (Build & Package Verification)
1. تشغيل سكربت البناء وإنتاج `dist/StaffSijilSystem.exe`.
2. التأكد من أن حجم الملف منطقي (يتراوح عادة بين 25 إلى 45 ميجابايت متضمناً كامل البيئة والمكتبات).
3. فحص خصائص الملف (`File Properties`) والتأكد من ظهور الأيقونة المخصصة وتفاصيل الإصدار.

### ثالثاً: فحص سيناريو النقل والتحديث ومقاومة الاستبدال (Upgrade & Overwrite Simulation)
1. تشغيل `StaffSijilSystem.exe` في مجلد مستقل جديد وإدخال موظف تجريبي.
2. التحقق من إنشاء `data/database.db` بنجاح.
3. محاكاة استلام تحديث جديد عبر استبدال ملف `StaffSijilSystem.exe` بملف آخر.
4. إعادة تشغيل البرنامج والتأكد من:
   - بيانات الموظف التجريبي لا تزال موجودة بالكامل ولم تُمسح (Zero Overwrite).
   - مجلد `backups/` يحتوي على نسخة احتياطية وقائية أُخذت تلقائياً في لحظة الإقلاع.
