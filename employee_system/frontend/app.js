/**
 * نظام سجل الموظفين المحمول (SSS) - منطق الواجهة البرمجية (app.js)
 * يدير الاتصال بالخلفية عبر PyWebView، وإدارة الحالة، والتحقق، والطباعة، والاستيراد والتصدير
 */

// ==================== الحالة العامة للتطبيق ====================
const state = {
  currentUser: null,
  users: [],
  statuses: [],
  activeFields: [],
  allFields: [],
  allStatuses: [],
  employees: [],
  selectedEmployeeIds: new Set(),
  defaultStatusId: null,
  pendingDeleteId: null,
  currentEditingEmpId: null,
  importSession: {
    filePath: null,
    newRecords: [],
    conflicts: [],
    conflictResolutions: {} // { national_id: 'update' | 'skip' }
  }
};

// واجهة برمجية وهمية للمتصفح العادي في حال الاختبار خارج pywebview
const mockAPI = {
  get_initial_data: async () => ({
    success: true,
    users: [
      { id: 1, display_name: "مدير النظام", role: "admin" },
      { id: 2, display_name: "موظف الإدخال", role: "staff" }
    ],
    statuses: [
      { id: 1, name: "على رأس العمل", is_active: 1 },
      { id: 2, name: "إجازة خاصة", is_active: 1 },
      { id: 3, name: "منتدب", is_active: 1 },
      { id: 4, name: "منقطع", is_active: 1 },
      { id: 5, name: "متقاعد", is_active: 1 }
    ],
    active_fields: []
  }),
  login: async (userId, pin) => {
    if ((userId === 1 && pin === "1234") || (userId === 2 && pin === "0000")) {
      return { success: true, user: { id: userId, display_name: userId === 1 ? "مدير النظام" : "موظف الإدخال", role: userId === 1 ? "admin" : "staff" } };
    }
    return { success: false, error: "رمز المرور غير صحيح" };
  },
  logout: async () => ({ success: true }),
  get_employees: async () => ({ success: true, employees: [] }),
  check_national_id: async () => ({ success: true, exists: false }),
  save_employee: async () => ({ success: true, message: "تم الحفظ بنجاح" }),
  update_employee_status: async () => ({ success: true }),
  delete_employee_permanent: async () => ({ success: true }),
  export_excel: async () => ({ success: true, message: "تم التصدير بنجاح" }),
  export_word: async () => ({ success: true, message: "تم تصدير ملف الوورد بنجاح" }),
  backup_database: async () => ({ success: true, message: "تم الحفظ بنجاح" }),
  restore_database: async () => ({ success: true, message: "تم الاسترجاع بنجاح" })
};

function getAPI() {
  if (window.pywebview && window.pywebview.api) {
    return window.pywebview.api;
  }
  return mockAPI;
}

// ==================== أدوات الإشعارات والنوافذ ====================

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let icon = "✅";
  if (type === "error") icon = "⚠️";
  if (type === "info") icon = "ℹ️";
  
  toast.innerHTML = `
    <span style="font-size: 18px;">${icon}</span>
    <span style="font-weight: 500;">${message}</span>
  `;
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-20px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showAlert(message, title = "تنبيه النظام") {
  document.getElementById("alert-modal-title").innerText = title;
  document.getElementById("alert-modal-text").innerText = message;
  openModal("modal-alert");
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add("active");
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove("active");
}

// ربط أزرار الإغلاق التلقائية للنوافذ
document.addEventListener("click", (e) => {
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) {
    const modalId = closeBtn.getAttribute("data-close");
    closeModal(modalId);
  }
});

// ==================== التهيئة ودورة الحياة ====================

window.addEventListener("pywebviewready", initApp);
window.addEventListener("DOMContentLoaded", () => {
  // إذا لم يكن pywebview جاهزاً بعد قليل نقوم بالتهيئة
  setTimeout(() => {
    if (!state.currentUser && !document.getElementById("modal-login").classList.contains("active")) {
      initApp();
    }
  }, 500);
});

async function initApp() {
  const api = getAPI();
  try {
    const res = await api.get_initial_data();
    if (res.success) {
      state.users = res.users || [];
      state.statuses = res.statuses || [];
      state.activeFields = res.active_fields || [];
      
      // العثور على معرف الحالة الافتراضية "على رأس العمل"
      const defaultStatus = state.statuses.find(s => s.name.includes("رأس العمل") || s.name.includes("العمل"));
      state.defaultStatusId = defaultStatus ? defaultStatus.id : (state.statuses[0]?.id || 1);

      populateLoginUsers();
      populateStatusDropdowns();
      openModal("modal-login");
    } else {
      showAlert(res.error || "تعذر الاتصال بقاعدة البيانات");
    }
  } catch (err) {
    console.error("Init error:", err);
  }
}

// تعبئة قائمة المستخدمين في شاشة الدخول
function populateLoginUsers() {
  const select = document.getElementById("login-user-select");
  select.innerHTML = "";
  state.users.forEach(u => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = `${u.display_name} (${u.role === "admin" ? "مدير النظام" : "موظف إدخال"})`;
    select.appendChild(opt);
  });
}

// تعبئة الحالات في شريط البحث واستمارة الإضافة
function populateStatusDropdowns() {
  const filterSelect = document.getElementById("filter-status");
  filterSelect.innerHTML = '<option value="all">-- كافة الحالات --</option>';
  state.statuses.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === state.defaultStatusId) {
      opt.selected = true; // الحالة الافتراضية "على رأس العمل"
    }
    filterSelect.appendChild(opt);
  });

  const empSelect = document.getElementById("emp-status-id");
  empSelect.innerHTML = "";
  state.statuses.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    empSelect.appendChild(opt);
  });
}

// ==================== تسجيل الدخول والخروج ====================

document.getElementById("btn-login-submit").addEventListener("click", handleLogin);
document.getElementById("login-pin-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});

async function handleLogin() {
  const userSelect = document.getElementById("login-user-select");
  const pinInput = document.getElementById("login-pin-input");
  const errorMsg = document.getElementById("login-error-msg");

  const userId = parseInt(userSelect.value, 10);
  const pin = pinInput.value.trim();

  if (!pin) {
    errorMsg.innerText = "يرجى إدخال رمز المرور (PIN)";
    errorMsg.classList.add("visible");
    return;
  }

  const api = getAPI();
  const res = await api.login(userId, pin);

  if (res.success && res.user) {
    state.currentUser = res.user;
    errorMsg.classList.remove("visible");
    pinInput.value = "";
    closeModal("modal-login");

    // تفعيل الواجهة وعرض بيانات المستخدم
    document.getElementById("main-app").style.display = "flex";
    document.getElementById("nav-user-panel").style.display = "flex";
    document.getElementById("nav-user-name").innerText = state.currentUser.display_name;

    const roleTag = document.getElementById("nav-user-role");
    if (state.currentUser.role === "admin") {
      roleTag.innerText = "مدير النظام";
      roleTag.className = "role-tag admin";
      document.querySelectorAll(".admin-only").forEach(el => el.style.display = "");
    } else {
      roleTag.innerText = "موظف إدخال";
      roleTag.className = "role-tag staff";
      document.querySelectorAll(".admin-only").forEach(el => el.style.display = "none");
    }

    showToast(`أهلاً بك يا ${state.currentUser.display_name}`);
    loadEmployees();
  } else {
    errorMsg.innerText = res.error || "رمز المرور (PIN) غير صحيح";
    errorMsg.classList.add("visible");
    pinInput.focus();
  }
}

document.getElementById("btn-logout").addEventListener("click", async () => {
  const api = getAPI();
  await api.logout();
  state.currentUser = null;
  state.selectedEmployeeIds.clear();
  document.getElementById("main-app").style.display = "none";
  document.getElementById("nav-user-panel").style.display = "none";
  openModal("modal-login");
  document.getElementById("login-pin-input").value = "";
});

// ==================== استعراض وبحث الموظفين ====================

document.getElementById("btn-search").addEventListener("click", () => loadEmployees());
document.getElementById("btn-reset-filters").addEventListener("click", () => {
  document.getElementById("search-name").value = "";
  document.getElementById("search-national-id").value = "";
  document.getElementById("filter-status").value = state.defaultStatusId || "all";
  loadEmployees();
});

// ضغط Enter في حقول البحث
document.getElementById("search-name").addEventListener("keydown", (e) => { if (e.key === "Enter") loadEmployees(); });
document.getElementById("search-national-id").addEventListener("keydown", (e) => { if (e.key === "Enter") loadEmployees(); });
document.getElementById("filter-status").addEventListener("change", () => loadEmployees());

async function loadEmployees() {
  const name = document.getElementById("search-name").value.trim();
  const nationalId = document.getElementById("search-national-id").value.trim();
  const statusId = document.getElementById("filter-status").value;

  const api = getAPI();
  const res = await api.get_employees(name, nationalId, statusId);

  if (res.success) {
    state.employees = res.employees || [];
    renderEmployeesTable();
  } else {
    showToast(res.error || "تعذر تحميل الموظفين", "error");
  }
}

function getStatusBadgeClass(statusName) {
  if (!statusName) return "status-active";
  if (statusName.includes("رأس العمل") || statusName.includes("العمل")) return "status-active";
  if (statusName.includes("إجازة")) return "status-leave";
  if (statusName.includes("منتدب")) return "status-delegated";
  if (statusName.includes("منقطع")) return "status-absent";
  if (statusName.includes("متقاعد")) return "status-retired";
  return "status-active";
}

function renderEmployeesTable() {
  const tbody = document.getElementById("employees-table-body");
  const emptyState = document.getElementById("table-empty-state");
  tbody.innerHTML = "";

  if (state.employees.length === 0) {
    emptyState.style.display = "block";
    updateSelectedCounter();
    return;
  }

  emptyState.style.display = "none";
  const isAdmin = state.currentUser && state.currentUser.role === "admin";

  state.employees.forEach(emp => {
    const isSelected = state.selectedEmployeeIds.has(emp.id);
    const tr = document.createElement("tr");
    if (isSelected) tr.classList.add("selected");

    const statusBadge = `<span class="status-badge ${getStatusBadgeClass(emp.status_name)}">${emp.status_name || "على رأس العمل"}</span>`;

    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="table-checkbox row-select-checkbox" data-id="${emp.id}" ${isSelected ? "checked" : ""}>
      </td>
      <td style="font-weight: 700; font-family: monospace; font-size: 14px;">${emp.national_id}</td>
      <td style="font-weight: 600; color: #1E293B;">${emp.full_name}</td>
      <td>${statusBadge}</td>
      <td>${emp.department || "-"}</td>
      <td>${emp.current_grade || "-"}</td>
      <td>${emp.education_level || "-"}</td>
      <td style="text-align: center;">
        <div class="table-actions" style="justify-content: center;">
          <button class="btn btn-sm btn-outline" onclick="openEditEmployeeModal(${emp.id})" title="عرض وتعديل البيانات">
            ✏️ تعديل
          </button>
          
          <select class="input-control" style="height: 32px; padding: 0 6px; font-size: 12px; width: 100px;" onchange="handleRoutineStatusChange(${emp.id}, this.value)">
            <option value="" disabled selected>الحالة...</option>
            ${state.statuses.map(s => `<option value="${s.id}" ${s.id === emp.status_id ? "selected" : ""}>${s.name}</option>`).join("")}
          </select>

          ${isAdmin ? `
            <button class="btn btn-sm btn-red" onclick="promptPermanentDelete(${emp.id}, '${emp.full_name}')" title="حذف نهائي من قاعدة البيانات">
              🗑️
            </button>
          ` : ""}
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });

  updateSelectedCounter();
}

// ==================== إدارة التحديد المتعدد ====================

document.getElementById("select-all-checkbox").addEventListener("change", (e) => {
  const checked = e.target.checked;
  state.employees.forEach(emp => {
    if (checked) {
      state.selectedEmployeeIds.add(emp.id);
    } else {
      state.selectedEmployeeIds.delete(emp.id);
    }
  });
  renderEmployeesTable();
});

document.addEventListener("change", (e) => {
  if (e.target.classList.contains("row-select-checkbox")) {
    const empId = parseInt(e.target.getAttribute("data-id"), 10);
    if (e.target.checked) {
      state.selectedEmployeeIds.add(empId);
    } else {
      state.selectedEmployeeIds.delete(empId);
    }
    const tr = e.target.closest("tr");
    if (tr) tr.classList.toggle("selected", e.target.checked);
    updateSelectedCounter();
  }
});

function updateSelectedCounter() {
  const count = state.selectedEmployeeIds.size;
  const badge = document.getElementById("selected-count-badge");
  badge.innerText = `المحدد: ${count} موظف`;

  const selectAll = document.getElementById("select-all-checkbox");
  if (state.employees.length > 0 && count === state.employees.length) {
    selectAll.checked = true;
    selectAll.indeterminate = false;
  } else if (count > 0) {
    selectAll.checked = false;
    selectAll.indeterminate = true;
  } else {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
}

// ==================== استمارة الموظف (إضافة وتعديل) ====================

document.getElementById("btn-add-employee").addEventListener("click", () => {
  openAddEmployeeModal();
});

function openAddEmployeeModal() {
  state.currentEditingEmpId = null;
  document.getElementById("employee-modal-title").innerText = "إضافة موظف جديد";
  document.getElementById("emp-id").value = "";
  document.getElementById("emp-national-id").value = "";
  document.getElementById("emp-full-name").value = "";
  document.getElementById("emp-status-id").value = state.defaultStatusId || (state.statuses[0]?.id || "");
  document.getElementById("emp-hire-date").value = "";
  document.getElementById("emp-department").value = "";
  document.getElementById("emp-current-grade").value = "";
  document.getElementById("emp-grade-date").value = "";
  document.getElementById("emp-education-level").value = "";
  document.getElementById("emp-specialization").value = "";

  document.getElementById("emp-national-id-warning").classList.remove("visible");
  document.getElementById("btn-save-employee").disabled = false;

  renderDynamicFieldsInForm({});
  openModal("modal-employee-form");
  document.getElementById("emp-national-id").focus();
}

async function openEditEmployeeModal(empId) {
  state.currentEditingEmpId = empId;
  const api = getAPI();
  const res = await api.get_employee(empId);

  if (res.success && res.employee) {
    const emp = res.employee;
    document.getElementById("employee-modal-title").innerText = `تعديل بيانات الموظف: ${emp.full_name}`;
    document.getElementById("emp-id").value = emp.id;
    document.getElementById("emp-national-id").value = emp.national_id || "";
    document.getElementById("emp-full-name").value = emp.full_name || "";
    document.getElementById("emp-status-id").value = emp.status_id || "";
    document.getElementById("emp-hire-date").value = emp.hire_date || "";
    document.getElementById("emp-department").value = emp.department || "";
    document.getElementById("emp-current-grade").value = emp.current_grade || "";
    document.getElementById("emp-grade-date").value = emp.grade_date || "";
    document.getElementById("emp-education-level").value = emp.education_level || "";
    document.getElementById("emp-specialization").value = emp.specialization || "";

    document.getElementById("emp-national-id-warning").classList.remove("visible");
    document.getElementById("btn-save-employee").disabled = false;

    renderDynamicFieldsInForm(emp.custom_values || {});
    openModal("modal-employee-form");
  } else {
    showToast("تعذر جلب تفاصيل الموظف", "error");
  }
}

function renderDynamicFieldsInForm(valuesMap) {
  const container = document.getElementById("dynamic-fields-container");
  const section = document.getElementById("dynamic-fields-section");
  container.innerHTML = "";

  if (!state.activeFields || state.activeFields.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  state.activeFields.forEach(f => {
    const div = document.createElement("div");
    div.className = "form-group";
    const val = valuesMap[f.field_key] || "";
    div.innerHTML = `
      <label for="custom-field-${f.field_key}">${f.label}</label>
      <input type="text" id="custom-field-${f.field_key}" class="input-control custom-field-input" data-key="${f.field_key}" value="${val}">
    `;
    container.appendChild(div);
  });
}

// التحقق السريع من الرقم الوطني عند blur
document.getElementById("emp-national-id").addEventListener("blur", checkNationalIdBlur);

async function checkNationalIdBlur() {
  const input = document.getElementById("emp-national-id");
  const warning = document.getElementById("emp-national-id-warning");
  const submitBtn = document.getElementById("btn-save-employee");
  const val = input.value.trim();

  if (!val) {
    warning.classList.remove("visible");
    submitBtn.disabled = false;
    return;
  }

  const api = getAPI();
  const res = await api.check_national_id(val, state.currentEditingEmpId);

  if (res.success && res.exists) {
    warning.innerText = `تنبيه: هذا الرقم الوطني مسجل مسبقاً باسم (${res.existing_name})`;
    warning.classList.add("visible");
    submitBtn.disabled = true;
  } else {
    warning.classList.remove("visible");
    submitBtn.disabled = false;
  }
}

// حفظ بيانات الموظف
document.getElementById("btn-save-employee").addEventListener("click", async () => {
  const nationalId = document.getElementById("emp-national-id").value.trim();
  const fullName = document.getElementById("emp-full-name").value.trim();
  const statusId = document.getElementById("emp-status-id").value;

  if (!nationalId) {
    showAlert("يرجى إدخال الرقم الوطني للموظف");
    return;
  }

  if (!fullName) {
    showAlert("يرجى إدخال الاسم الكامل للموظف");
    return;
  }

  if (!statusId) {
    showAlert("يرجى تحديد الحالة الوظيفية للموظف");
    return;
  }

  const empData = {
    id: state.currentEditingEmpId || null,
    national_id: nationalId,
    full_name: fullName,
    status_id: parseInt(statusId, 10),
    hire_date: document.getElementById("emp-hire-date").value,
    department: document.getElementById("emp-department").value.trim(),
    current_grade: document.getElementById("emp-current-grade").value.trim(),
    grade_date: document.getElementById("emp-grade-date").value,
    education_level: document.getElementById("emp-education-level").value.trim(),
    specialization: document.getElementById("emp-specialization").value.trim()
  };

  // جمع قيم الحقول الديناميكية
  const customValues = {};
  document.querySelectorAll(".custom-field-input").forEach(inp => {
    const key = inp.getAttribute("data-key");
    customValues[key] = inp.value.trim();
  });

  const api = getAPI();
  const res = await api.save_employee(empData, customValues);

  if (res.success) {
    showToast(res.message || "تم حفظ البيانات بنجاح");
    closeModal("modal-employee-form");
    loadEmployees();
  } else {
    showAlert(res.error || "تعذر حفظ السجل، يرجى التأكد من ملء الحقول المطلوبة");
  }
});

// ==================== تغيير الحالة والحذف ====================

async function handleRoutineStatusChange(empId, statusId) {
  if (!statusId) return;
  const api = getAPI();
  const res = await api.update_employee_status(empId, parseInt(statusId, 10));
  if (res.success) {
    showToast("تم تحديث الحالة الوظيفية بنجاح");
    loadEmployees();
  } else {
    showToast(res.error || "تعذر تحديث الحالة", "error");
  }
}

function promptPermanentDelete(empId, empName) {
  state.pendingDeleteId = empId;
  document.getElementById("confirm-modal-title").innerText = "تحذير: حذف نهائي";
  document.getElementById("confirm-modal-text").innerText =
    `تحذير: سيتم حذف هذا السجل نهائياً من قاعدة البيانات للموظف [${empName}]. هل تريد المتابعة؟`;
  openModal("modal-confirm");
}

document.getElementById("btn-confirm-proceed").addEventListener("click", async () => {
  if (!state.pendingDeleteId) return;
  const api = getAPI();
  const res = await api.delete_employee_permanent(state.pendingDeleteId);
  closeModal("modal-confirm");

  if (res.success) {
    showToast(res.message || "تم حذف السجل نهائياً من قاعدة البيانات");
    state.selectedEmployeeIds.delete(state.pendingDeleteId);
    state.pendingDeleteId = null;
    loadEmployees();
  } else {
    showAlert(res.error || "تعذر إتمام الحذف");
  }
});

document.getElementById("btn-confirm-cancel").addEventListener("click", () => {
  state.pendingDeleteId = null;
  closeModal("modal-confirm");
});

// ==================== الطباعة وتصدير Word ====================

document.getElementById("btn-open-print").addEventListener("click", () => {
  if (state.selectedEmployeeIds.size === 0) {
    showAlert("يرجى تحديد موظف واحد على الأقل من الجدول لإجراء الطباعة أو التصدير.");
    return;
  }
  openPrintSetupModal();
});

function openPrintSetupModal() {
  const count = state.selectedEmployeeIds.size;
  document.getElementById("print-selected-info").innerText = `عدد الموظفين المحددين للطباعة: (${count}) موظف`;

  // بناء قائمة الحقول للاختيار
  const checklist = document.getElementById("print-fields-checklist");
  checklist.innerHTML = "";

  const coreFields = [
    { key: "national_id", label: "الرقم الوطني" },
    { key: "full_name", label: "الاسم الكامل" },
    { key: "status_name", label: "الحالة الوظيفية" },
    { key: "hire_date", label: "تاريخ التعيين" },
    { key: "department", label: "القسم / الإدارة" },
    { key: "current_grade", label: "الدرجة الحالية" },
    { key: "grade_date", label: "تاريخ الدرجة" },
    { key: "education_level", label: "المؤهل العلمي" },
    { key: "specialization", label: "التخصص" }
  ];

  coreFields.forEach(f => {
    const lbl = document.createElement("label");
    lbl.className = "checkbox-label";
    lbl.innerHTML = `
      <input type="checkbox" class="table-checkbox print-field-item" value="${f.key}" checked>
      <span>${f.label}</span>
    `;
    checklist.appendChild(lbl);
  });

  state.activeFields.forEach(f => {
    const lbl = document.createElement("label");
    lbl.className = "checkbox-label";
    lbl.innerHTML = `
      <input type="checkbox" class="table-checkbox print-field-item" value="custom_${f.field_key}" checked>
      <span>${f.label} (مخصص)</span>
    `;
    checklist.appendChild(lbl);
  });

  document.getElementById("print-toggle-all-fields").checked = true;
  openModal("modal-print-setup");
}

// تبديل نوع التقرير في الواجهة
document.getElementById("radio-report-cards").addEventListener("click", () => {
  document.getElementById("report-type-cards").checked = true;
  document.getElementById("radio-report-cards").classList.add("selected");
  document.getElementById("radio-report-table").classList.remove("selected");
});

document.getElementById("radio-report-table").addEventListener("click", () => {
  document.getElementById("report-type-table").checked = true;
  document.getElementById("radio-report-table").classList.add("selected");
  document.getElementById("radio-report-cards").classList.remove("selected");
});

// تحديد / إلغاء تحديد الكل للحقول
document.getElementById("print-toggle-all-fields").addEventListener("change", (e) => {
  const checked = e.target.checked;
  document.querySelectorAll(".print-field-item").forEach(cb => cb.checked = checked);
});

// تنفيذ الطباعة الفورية / PDF عبر متصفح الويب (A4 Styling)
document.getElementById("btn-do-print").addEventListener("click", () => {
  const reportType = document.querySelector('input[name="report_type"]:checked').value;
  const selectedFields = Array.from(document.querySelectorAll(".print-field-item:checked")).map(cb => cb.value);

  if (selectedFields.length === 0) {
    showAlert("يرجى تحديد حقل واحد على الأقل لإظهاره في التقرير");
    return;
  }

  const selectedEmployees = state.employees.filter(e => state.selectedEmployeeIds.has(e.id));
  buildPrintDOM(reportType, selectedEmployees, selectedFields);

  closeModal("modal-print-setup");

  // تشغيل الطباعة بمحرك المتصفح
  setTimeout(() => {
    window.print();
  }, 250);
});

function buildPrintDOM(reportType, employees, selectedFields) {
  const root = document.getElementById("print-root");
  root.innerHTML = "";

  const fieldLabelsMap = {
    national_id: "الرقم الوطني",
    full_name: "الاسم الكامل",
    status_name: "الحالة الوظيفية",
    hire_date: "تاريخ التعيين",
    department: "القسم / الإدارة",
    current_grade: "الدرجة الحالية",
    grade_date: "تاريخ الدرجة",
    education_level: "المؤهل العلمي",
    specialization: "التخصص"
  };

  state.activeFields.forEach(f => {
    fieldLabelsMap[`custom_${f.field_key}`] = f.label;
  });

  if (reportType === "cards") {
    // بطاقات موظفين مستقلة (كل بطاقة في صفحة A4)
    employees.forEach(emp => {
      const card = document.createElement("div");
      card.className = "print-employee-card";

      let rowsHtml = "";
      selectedFields.forEach(fKey => {
        let val = "";
        if (fKey.startsWith("custom_")) {
          const rawKey = fKey.replace("custom_", "");
          val = emp.custom_values?.[rawKey] || "-";
        } else {
          val = emp[fKey] || "-";
        }

        rowsHtml += `
          <tr>
            <td class="field-label">${fieldLabelsMap[fKey] || fKey}</td>
            <td>${val}</td>
          </tr>
        `;
      });

      card.innerHTML = `
        <div class="print-card-header">
          <h2>بطاقة بيانات موظف</h2>
          <p>تاريخ استخراج التقرير: ${new Date().toLocaleDateString("ar-EG")}  |  الرقم الوطني: ${emp.national_id}</p>
        </div>
        <table class="print-card-table">
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
        <div class="print-card-footer">
          <span>اعتماد رئيس القسم: __________________</span>
          <span>التوقيع والختم: __________________</span>
        </div>
      `;

      root.appendChild(card);
    });
  } else {
    // كشف جدولي مجمع مع تكرار رأس الجدول في كل صفحة
    const tableContainer = document.createElement("div");
    tableContainer.className = "print-table-report";

    let thHtml = "";
    selectedFields.forEach(fKey => {
      thHtml += `<th>${fieldLabelsMap[fKey] || fKey}</th>`;
    });

    let trHtml = "";
    employees.forEach((emp, idx) => {
      let tdHtml = "";
      selectedFields.forEach(fKey => {
        let val = "";
        if (fKey.startsWith("custom_")) {
          const rawKey = fKey.replace("custom_", "");
          val = emp.custom_values?.[rawKey] || "-";
        } else {
          val = emp[fKey] || "-";
        }
        tdHtml += `<td style="${fKey === 'full_name' ? 'text-align: right;' : 'text-align: center;'}">${val}</td>`;
      });

      trHtml += `<tr>${tdHtml}</tr>`;
    });

    tableContainer.innerHTML = `
      <div class="print-table-header">
        <h2>كشف موظفين مجمع</h2>
        <p style="font-size: 10pt; color: #64748B;">تاريخ التقرير: ${new Date().toLocaleDateString("ar-EG")}  |  إجمالي السجلات: ${employees.length} موظف</p>
      </div>
      <table class="print-table-data">
        <thead>
          <tr>${thHtml}</tr>
        </thead>
        <tbody>
          ${trHtml}
        </tbody>
      </table>
    `;

    root.appendChild(tableContainer);
  }
}

// تصدير كملف Word (.docx)
document.getElementById("btn-do-word-export").addEventListener("click", async () => {
  const reportType = document.querySelector('input[name="report_type"]:checked').value;
  const selectedFields = Array.from(document.querySelectorAll(".print-field-item:checked")).map(cb => cb.value);

  if (selectedFields.length === 0) {
    showAlert("يرجى تحديد حقل واحد على الأقل");
    return;
  }

  const selectedIds = Array.from(state.selectedEmployeeIds);
  const api = getAPI();
  const res = await api.export_word(reportType, selectedIds, selectedFields);

  if (res.success) {
    showToast(res.message || "تم تصدير ملف الوورد بنجاح");
    closeModal("modal-print-setup");
  } else if (!res.cancelled) {
    showAlert(res.error || "تعذر إتمام تصدير الوورد");
  }
});

// ==================== تصدير واستيراد الإكسل ====================

document.getElementById("btn-export-excel").addEventListener("click", async () => {
  const name = document.getElementById("search-name").value.trim();
  const nationalId = document.getElementById("search-national-id").value.trim();
  const statusId = document.getElementById("filter-status").value;
  const selectedIds = state.selectedEmployeeIds.size > 0 ? Array.from(state.selectedEmployeeIds) : null;

  const api = getAPI();
  const res = await api.export_excel(name, nationalId, statusId, selectedIds);

  if (res.success) {
    showToast(res.message || "تم تصدير ملف الإكسل بنجاح");
  } else if (!res.cancelled) {
    showAlert(res.error || "تعذر تصدير ملف الإكسل");
  }
});

// معالج استيراد الإكسل (خطوة بخطوة)
document.getElementById("btn-import-excel").addEventListener("click", () => {
  resetImportWizard();
  openModal("modal-excel-import");
});

function resetImportWizard() {
  state.importSession = {
    filePath: null,
    newRecords: [],
    conflicts: [],
    conflictResolutions: {}
  };

  document.getElementById("import-step-upload").style.display = "block";
  document.getElementById("import-step-conflicts").style.display = "none";
  document.getElementById("import-step-summary").style.display = "none";
  document.getElementById("btn-import-commit").style.display = "none";
}

document.getElementById("btn-browse-excel-file").addEventListener("click", async () => {
  const api = getAPI();
  const res = await api.import_excel_browse_and_validate();

  if (res.cancelled) return;

  if (!res.success) {
    // إيقاف العملية الفوري بالرسالة المطلوبة بالضبط
    showAlert(res.error || "حدث خطأ أثناء فحص ملف الإكسل");
    return;
  }

  state.importSession.filePath = res.file_path;
  state.importSession.newRecords = res.new_records || [];
  state.importSession.conflicts = res.conflicts || [];
  state.importSession.conflictResolutions = {};

  if (state.importSession.conflicts.length > 0) {
    // الانتقال لمرحلة فض التعارض
    document.getElementById("import-step-upload").style.display = "none";
    document.getElementById("import-step-conflicts").style.display = "block";
    document.getElementById("btn-import-commit").style.display = "inline-flex";

    renderConflictCards();
  } else {
    // لا يوجد تعارض - استيراد مباشر
    commitImport();
  }
});

function renderConflictCards() {
  const container = document.getElementById("conflicts-list-container");
  container.innerHTML = "";

  state.importSession.conflicts.forEach((c, idx) => {
    state.importSession.conflictResolutions[c.national_id] = "update"; // الافتراضي تحديث

    const card = document.createElement("div");
    card.className = "conflict-card";
    card.innerHTML = `
      <div class="conflict-info">
        <strong>الرقم الوطني [${c.national_id}]</strong> مسجل مسبقاً باسم [${c.existing_name}].<br>
        البيانات الواردة في الملف: [${c.new_name}].
      </div>
      <div class="conflict-actions">
        <label class="checkbox-label" style="font-weight: 600;">
          <input type="radio" name="conflict_${idx}" value="update" checked onchange="setConflictResolution('${c.national_id}', 'update')">
          <span>[ تحديث بيانات الموظف ]</span>
        </label>
        <label class="checkbox-label" style="font-weight: 600; margin-right: 18px;">
          <input type="radio" name="conflict_${idx}" value="skip" onchange="setConflictResolution('${c.national_id}', 'skip')">
          <span>[ تخطي هذا السجل ]</span>
        </label>
      </div>
    `;
    container.appendChild(card);
  });
}

window.setConflictResolution = function(nationalId, action) {
  state.importSession.conflictResolutions[nationalId] = action;
};

document.getElementById("btn-resolve-update-all").addEventListener("click", () => {
  state.importSession.conflicts.forEach(c => {
    state.importSession.conflictResolutions[c.national_id] = "update";
  });
  document.querySelectorAll('input[type="radio"][value="update"]').forEach(r => r.checked = true);
});

document.getElementById("btn-resolve-skip-all").addEventListener("click", () => {
  state.importSession.conflicts.forEach(c => {
    state.importSession.conflictResolutions[c.national_id] = "skip";
  });
  document.querySelectorAll('input[type="radio"][value="skip"]').forEach(r => r.checked = true);
});

document.getElementById("btn-import-commit").addEventListener("click", () => {
  commitImport();
});

async function commitImport() {
  const resolvedConflicts = state.importSession.conflicts.map(c => ({
    ...c,
    action: state.importSession.conflictResolutions[c.national_id] || "update"
  }));

  const api = getAPI();
  const res = await api.import_excel_commit(
    state.importSession.newRecords,
    resolvedConflicts
  );

  if (res.success) {
    document.getElementById("import-step-upload").style.display = "none";
    document.getElementById("import-step-conflicts").style.display = "none";
    document.getElementById("btn-import-commit").style.display = "none";

    document.getElementById("import-step-summary").style.display = "block";
    document.getElementById("import-summary-text").innerText =
      `تم استيراد عدد (${res.inserted_count}) موظف جديد وتحديث عدد (${res.updated_count}) موظف بنجاح (وتم تخطي ${res.skipped_count} سجل).`;

    showToast("تمت معالجة ملف الإكسل بنجاح");
    loadEmployees();
  } else {
    showAlert(res.error || "حدث خطأ أثناء حفظ السجلات المستوردة");
  }
}

// ==================== النسخ الاحتياطي والاسترجاع ====================

document.getElementById("btn-backup-db").addEventListener("click", async () => {
  const api = getAPI();
  const res = await api.backup_database();
  if (res.success) {
    showToast(res.message || "تم حفظ النسخة الاحتياطية بنجاح");
  } else if (!res.cancelled) {
    showAlert(res.error || "فشل إنشاء النسخة الاحتياطية");
  }
});

document.getElementById("btn-restore-db").addEventListener("click", async () => {
  const api = getAPI();
  const res = await api.restore_database();
  if (res.success) {
    showToast(res.message || "تم استرجاع النسخة الاحتياطية بنجاح");
    // إعادة تحميل البيانات
    initApp();
  } else if (!res.cancelled) {
    showAlert(res.error || "تعذر استرجاع النسخة الاحتياطية");
  }
});

// ==================== إدارة الحقول والحالات (Settings) ====================

document.getElementById("btn-open-settings").addEventListener("click", () => {
  loadSettingsData();
  openModal("modal-settings");
});

document.getElementById("tab-btn-fields").addEventListener("click", () => {
  document.getElementById("tab-content-fields").style.display = "block";
  document.getElementById("tab-content-statuses").style.display = "none";
  document.getElementById("tab-btn-fields").className = "btn btn-sm btn-blue";
  document.getElementById("tab-btn-statuses").className = "btn btn-sm btn-outline";
});

document.getElementById("tab-btn-statuses").addEventListener("click", () => {
  document.getElementById("tab-content-fields").style.display = "none";
  document.getElementById("tab-content-statuses").style.display = "block";
  document.getElementById("tab-btn-fields").className = "btn btn-sm btn-outline";
  document.getElementById("tab-btn-statuses").className = "btn btn-sm btn-blue";
});

async function loadSettingsData() {
  const api = getAPI();
  const [fieldsRes, statusesRes] = await Promise.all([
    api.get_all_fields(),
    api.get_all_statuses()
  ]);

  if (fieldsRes.success) {
    state.allFields = fieldsRes.fields || [];
    renderSettingsFields();
  }
  if (statusesRes.success) {
    state.allStatuses = statusesRes.statuses || [];
    renderSettingsStatuses();
  }
}

function renderSettingsFields() {
  const tbody = document.getElementById("fields-table-body");
  tbody.innerHTML = "";
  state.allFields.forEach(f => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family: monospace;">${f.field_key}</td>
      <td style="font-weight: 600;">${f.label}</td>
      <td>${f.display_order}</td>
      <td>
        <span class="status-badge ${f.is_active ? 'status-active' : 'status-absent'}">
          ${f.is_active ? 'نشط' : 'معطل'}
        </span>
      </td>
      <td>
        <button class="btn btn-sm ${f.is_active ? 'btn-red' : 'btn-green'}" onclick="toggleFieldStatus(${f.id}, ${f.is_active ? 0 : 1})">
          ${f.is_active ? 'تعطيل' : 'تفعيل'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderSettingsStatuses() {
  const tbody = document.getElementById("statuses-table-body");
  tbody.innerHTML = "";
  state.allStatuses.forEach(s => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.id}</td>
      <td style="font-weight: 600;">${s.name}</td>
      <td>
        <span class="status-badge ${s.is_active ? 'status-active' : 'status-absent'}">
          ${s.is_active ? 'نشط' : 'معطل'}
        </span>
      </td>
      <td>
        <button class="btn btn-sm ${s.is_active ? 'btn-red' : 'btn-green'}" onclick="toggleStatusState(${s.id}, ${s.is_active ? 0 : 1})">
          ${s.is_active ? 'تعطيل' : 'تفعيل'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById("btn-add-field-submit").addEventListener("click", async () => {
  const key = document.getElementById("new-field-key").value.trim();
  const label = document.getElementById("new-field-label").value.trim();
  const order = parseInt(document.getElementById("new-field-order").value, 10) || 0;

  if (!key || !label) {
    showAlert("يرجى إدخال المفتاح والتسمية للحقل الجديد");
    return;
  }

  const api = getAPI();
  const res = await api.save_field(key, label, order);
  if (res.success) {
    showToast("تمت إضافة الحقل الديناميكي بنجاح");
    document.getElementById("new-field-key").value = "";
    document.getElementById("new-field-label").value = "";
    loadSettingsData();
    // تحديث قائمة الحقول النشطة
    const initRes = await api.get_initial_data();
    if (initRes.success) state.activeFields = initRes.active_fields;
  } else {
    showAlert(res.error || "تعذر إضافة الحقل");
  }
});

window.toggleFieldStatus = async function(fieldId, targetActive) {
  const api = getAPI();
  const res = await api.toggle_field(fieldId, targetActive);
  if (res.success) {
    showToast("تم تحديث حالة الحقل");
    loadSettingsData();
    const initRes = await api.get_initial_data();
    if (initRes.success) state.activeFields = initRes.active_fields;
  }
};

document.getElementById("btn-add-status-submit").addEventListener("click", async () => {
  const name = document.getElementById("new-status-name").value.trim();
  if (!name) {
    showAlert("يرجى إدخال اسم الحالة");
    return;
  }

  const api = getAPI();
  const res = await api.save_status(name);
  if (res.success) {
    showToast("تمت إضافة الحالة الوظيفية بنجاح");
    document.getElementById("new-status-name").value = "";
    loadSettingsData();
    populateStatusDropdowns();
  } else {
    showAlert(res.error || "تعذر إضافة الحالة");
  }
});

window.toggleStatusState = async function(statusId, targetActive) {
  const api = getAPI();
  const res = await api.toggle_status(statusId, targetActive);
  if (res.success) {
    showToast("تم تحديث حالة التشغيل");
    loadSettingsData();
    populateStatusDropdowns();
  }
};
