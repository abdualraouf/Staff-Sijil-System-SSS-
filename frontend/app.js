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

function getAPI() {
  return window.pywebview ? window.pywebview.api : null;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

function closeTopActiveModal() {
  const activeModals = Array.from(document.querySelectorAll(".modal-overlay.active"));
  if (activeModals.length === 0) return false;

  // استبعاد نافذة تسجيل الدخول إذا لم يسجل المستخدم دخوله بعد
  const dismissableModals = activeModals.filter(m => {
    if (m.id === "modal-login" && !state.currentUser) return false;
    return true;
  });

  if (dismissableModals.length === 0) return false;

  // جلب آخر نافذة نشطة تم فتحها (الأعلى في شجرة العرض)
  const topModal = dismissableModals[dismissableModals.length - 1];

  if (topModal.id === "modal-confirm") {
    state.pendingDeleteId = null;
    customConfirmCallback = null;
    closeModal("modal-confirm");
  } else {
    closeModal(topModal.id);
  }
  return true;
}

// ربط أزرار الإغلاق التلقائية للنوافذ
document.addEventListener("click", (e) => {
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) {
    const modalId = closeBtn.getAttribute("data-close");
    closeModal(modalId);
  }
});

// ==================== حماية عناصر الواجهة من النسخ والقوائم المنبثقة ====================

// منع القائمة السياقية (Right-Click Context Menu) على الأزرار والقوائم والترويسات
document.addEventListener("contextmenu", (e) => {
  // السماح فقط داخل حقول الإدخال النصية ومناطق التحرير لإتاحة اللصق والقص
  const isTextInput = e.target.closest("input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']), textarea");
  if (!isTextInput) {
    e.preventDefault();
  }
});

// منع سحب عناصر الواجهة والأزرار ككائنات متصفح
document.addEventListener("dragstart", (e) => {
  if (!e.target.closest("input, textarea")) {
    e.preventDefault();
  }
});

// منع نسخ نصوص الأزرار والقوائم وعناصر التحكم
document.addEventListener("copy", (e) => {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const anchor = selection.anchorNode;
    const el = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentElement) : null;
    if (el && el.closest("button, .btn, .top-navbar, .toolbar-card, .search-card, .modal-header, .modal-footer, [id^='tab-btn-'], .status-badge, .role-tag")) {
      e.preventDefault();
    }
  }
});

// حظر اختصارات المتصفح العشوائية (F5 / Ctrl+R / Ctrl+U) وتوجيه أمر الطباعة وإغلاق النوافذ بـ Escape
document.addEventListener("keydown", (e) => {
  // إغلاق أعلى نافذة منبثقة نشطة عند الضغط على مفتاح الهروب Escape
  if (e.key === "Escape" || e.key === "Esc") {
    const closed = closeTopActiveModal();
    if (closed) {
      e.preventDefault();
      return;
    }
  }

  // حظر F5 وحظر Ctrl+R / Ctrl+Shift+R (إعادة التحميل المفاجئ وفقدان الجلسة)
  if (e.key === "F5" || (e.ctrlKey && (e.key === "r" || e.key === "R"))) {
    e.preventDefault();
    return;
  }

  // حظر Ctrl+U (عرض كود المصدر)
  if (e.ctrlKey && (e.key === "u" || e.key === "U")) {
    e.preventDefault();
    return;
  }

  // توجيه اختصار الطباعة Ctrl+P لنافذة طباعة المنظومة الرسمية
  if (e.ctrlKey && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    if (state.currentUser) {
      document.getElementById("btn-open-print").click();
    }
    return;
  }
});

// ==================== التهيئة ودورة الحياة ====================

let appInitialized = false;

async function initApp() {
  if (appInitialized) return;
  const api = window.pywebview ? window.pywebview.api : null;
  if (!api || typeof api.get_initial_data !== "function") {
    return false;
  }
  appInitialized = true;

  try {
    const res = await api.get_initial_data();
    if (res.success) {
      state.users = res.users || [];
      state.statuses = res.statuses || [];
      state.activeFields = res.active_fields || [];
      
      // تعيين الحالة الافتراضية بناءً على إعدادات حقل status_id أو المسمى
      const statusFieldDef = state.activeFields.find(f => f.field_key === "status_id");
      if (statusFieldDef && statusFieldDef.default_value && state.statuses.some(s => String(s.id) === String(statusFieldDef.default_value))) {
        state.defaultStatusId = parseInt(statusFieldDef.default_value, 10);
      } else {
        const defaultStatus = state.statuses.find(s => s.name.includes("رأس العمل") || s.name.includes("العمل"));
        state.defaultStatusId = defaultStatus ? defaultStatus.id : (state.statuses[0]?.id || 1);
      }

      populateLoginUsers();
      populateStatusDropdowns();
      renderEmployeesTableHeader();
      openModal("modal-login");
      return true;
    } else {
      showAlert(res.error || "تعذر الاتصال بقاعدة البيانات");
    }
  } catch (err) {
    console.error("Init error:", err);
  }
  return false;
}

// دالة إعادة تحميل وتحديث كافة بيانات النظام الحية بعد استرجاع نسخة احتياطية أو هجرة بيانات
async function reloadSystemData() {
  const api = getAPI();
  if (!api || typeof api.get_initial_data !== "function") return false;

  try {
    const res = await api.get_initial_data();
    if (res.success) {
      state.users = res.users || [];
      state.statuses = res.statuses || [];
      state.activeFields = res.active_fields || [];

      const statusFieldDef = state.activeFields.find(f => f.field_key === "status_id");
      if (statusFieldDef && statusFieldDef.default_value && state.statuses.some(s => String(s.id) === String(statusFieldDef.default_value))) {
        state.defaultStatusId = parseInt(statusFieldDef.default_value, 10);
      } else {
        const defaultStatus = state.statuses.find(s => s.name.includes("رأس العمل") || s.name.includes("العمل"));
        state.defaultStatusId = defaultStatus ? defaultStatus.id : (state.statuses[0]?.id || 1);
      }

      populateLoginUsers();
      populateStatusDropdowns();
      renderEmployeesTableHeader();

      // إعادة تحميل جدول الموظفين وتفريغ التحديدات
      state.selectedEmployeeIds.clear();
      await loadEmployees();

      // إذا كانت نافذة الإعدادات مفتوحة، تحديث بياناتها
      const settingsModal = document.getElementById("modal-settings");
      if (settingsModal && settingsModal.classList.contains("active")) {
        loadSettingsData();
      }
      return true;
    }
  } catch (err) {
    console.error("Reload error:", err);
  }
  return false;
}

function tryInit() {
  if (appInitialized) return;
  initApp();
}

window.addEventListener("pywebviewready", tryInit);
document.addEventListener("DOMContentLoaded", tryInit);
window.addEventListener("load", tryInit);

// فحص دوري سريع للتأكد من التقاط الجسر البرمجي فور جاهزيته
const initTimer = setInterval(() => {
  if (appInitialized) {
    clearInterval(initTimer);
  } else {
    tryInit();
  }
}, 50);

setTimeout(() => clearInterval(initTimer), 6000);

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
  filterSelect.innerHTML = '<option value="all" selected>-- كافة الحالات --</option>';
  state.statuses.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    filterSelect.appendChild(opt);
  });
  filterSelect.value = "all";

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
      document.querySelectorAll(".staff-only").forEach(el => el.style.display = "none");
    } else {
      roleTag.innerText = "موظف إدخال";
      roleTag.className = "role-tag staff";
      document.querySelectorAll(".admin-only").forEach(el => el.style.display = "none");
      document.querySelectorAll(".staff-only").forEach(el => el.style.display = "");
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

// دالة شاملة ومرنة لتصفير كافة فلاتر البحث وإعادتها لحالتها الافتراضية
function resetAllSearchFilters() {
  const searchCard = document.querySelector(".search-card");
  if (!searchCard) {
    const nameEl = document.getElementById("search-name");
    const natEl = document.getElementById("search-national-id");
    const statEl = document.getElementById("filter-status");
    if (nameEl) nameEl.value = "";
    if (natEl) natEl.value = "";
    if (statEl) statEl.value = "all";
    return;
  }

  // تصفير كافة حقول الإدخال النصية في شريط البحث
  searchCard.querySelectorAll("input:not([type='button']):not([type='submit'])").forEach(input => {
    input.value = "";
  });

  // إعادة كافة القوائم المنسدلة إلى خيارها الافتراضي (-- كافة الحالات -- وما يماثلها مستقبلاً)
  searchCard.querySelectorAll("select").forEach(select => {
    const defaultOpt = Array.from(select.options).find(opt => opt.defaultSelected);
    if (defaultOpt) {
      select.value = defaultOpt.value;
    } else if (select.options.length > 0) {
      select.selectedIndex = 0;
    }
  });
}

document.getElementById("btn-search").addEventListener("click", () => loadEmployees());
document.getElementById("btn-reset-filters").addEventListener("click", () => {
  resetAllSearchFilters();
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

function getVisibleColumns() {
  if (!state.activeFields || state.activeFields.length === 0) {
    return [
      { field_key: "national_id", label: "الرقم الوطني" },
      { field_key: "full_name", label: "الاسم الكامل" },
      { field_key: "status_id", label: "الحالة الوظيفية" },
      { field_key: "department", label: "القسم / الإدارة" },
      { field_key: "current_grade", label: "الدرجة الحالية" },
      { field_key: "education_level", label: "المؤهل العلمي" }
    ];
  }
  return state.activeFields.slice(0, 6);
}

function syncSelectAllCheckbox() {
  const selectAll = document.getElementById("select-all-checkbox");
  if (!selectAll) return;

  const totalVisible = state.employees.length;
  if (totalVisible === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedVisibleCount = state.employees.filter(emp => state.selectedEmployeeIds.has(emp.id)).length;

  if (selectedVisibleCount === totalVisible) {
    selectAll.checked = true;
    selectAll.indeterminate = false;
  } else if (selectedVisibleCount > 0) {
    selectAll.checked = false;
    selectAll.indeterminate = true;
  } else {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
}

function renderEmployeesTableHeader() {
  const thead = document.getElementById("employees-table-head");
  if (!thead) return;

  const cols = getVisibleColumns();
  let html = `
    <tr>
      <th style="width: 44px; text-align: center;">
        <input type="checkbox" id="select-all-checkbox" class="table-checkbox" title="تحديد الكل">
      </th>
  `;

  cols.forEach(col => {
    html += `<th>${escapeHtml(col.label)}</th>`;
  });

  html += `
      <th style="text-align: center; width: 140px;">الإجراءات</th>
    </tr>
  `;

  thead.innerHTML = html;
  syncSelectAllCheckbox();
}

function renderEmployeesTable() {
  renderEmployeesTableHeader();
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
  const cols = getVisibleColumns();

  state.employees.forEach(emp => {
    const isSelected = state.selectedEmployeeIds.has(emp.id);
    const tr = document.createElement("tr");
    if (isSelected) tr.classList.add("selected");

    let rowHtml = `
      <td style="text-align: center;">
        <input type="checkbox" class="table-checkbox row-select-checkbox" data-id="${emp.id}" ${isSelected ? "checked" : ""}>
      </td>
    `;

    cols.forEach(col => {
      const key = col.field_key;
      if (key === "status_id") {
        const statusBadge = `<span class="status-badge ${getStatusBadgeClass(emp.status_name)}">${escapeHtml(emp.status_name || "على رأس العمل")}</span>`;
        rowHtml += `<td>${statusBadge}</td>`;
      } else if (key === "national_id") {
        rowHtml += `<td style="font-weight: 700; font-family: monospace; font-size: 14px;">${escapeHtml(emp.national_id || "-")}</td>`;
      } else if (key === "full_name") {
        rowHtml += `<td style="font-weight: 600; color: #1E293B;">${escapeHtml(emp.full_name || "-")}</td>`;
      } else {
        const rawVal = emp[key] !== undefined && emp[key] !== null && String(emp[key]).trim() !== ""
          ? emp[key]
          : (emp.custom_values && emp.custom_values[key] !== undefined ? emp.custom_values[key] : "");
        const displayVal = (rawVal !== "" && rawVal !== null && rawVal !== undefined) ? rawVal : "-";
        rowHtml += `<td>${escapeHtml(displayVal)}</td>`;
      }
    });

    rowHtml += `
      <td style="text-align: center;">
        <div class="table-actions" style="justify-content: center;">
          <button class="btn btn-sm btn-outline" onclick="openEditEmployeeModal(${emp.id})" title="عرض وتعديل كافة بيانات الموظف بما فيها الحالة الوظيفية">
            ✏️ تعديل
          </button>

          ${isAdmin ? `
            <button class="btn btn-sm btn-red" onclick="promptPermanentDelete(${emp.id}, '${escapeHtml(emp.full_name)}')" title="حذف نهائي من قاعدة البيانات">
              🗑️
            </button>
          ` : ""}
        </div>
      </td>
    `;

    tr.innerHTML = rowHtml;
    tbody.appendChild(tr);
  });

  updateSelectedCounter();
}

// ==================== إدارة التحديد المتعدد ====================

document.addEventListener("change", (e) => {
  if (e.target.id === "select-all-checkbox") {
    const checked = e.target.checked;
    state.employees.forEach(emp => {
      if (checked) {
        state.selectedEmployeeIds.add(emp.id);
      } else {
        state.selectedEmployeeIds.delete(emp.id);
      }
    });

    // تحديث مربعات الاختيار في صفوف الجدول المرئية فوراً دون تأخير
    document.querySelectorAll(".row-select-checkbox").forEach(cb => {
      cb.checked = checked;
      const tr = cb.closest("tr");
      if (tr) tr.classList.toggle("selected", checked);
    });

    updateSelectedCounter();
    return;
  }

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
  if (badge) {
    badge.innerText = `المحدد: ${count} موظف`;
  }

  // إظهار وتحديث زر الحذف الجماعي لمدير النظام عند وجود تحديد
  const btnDeleteSelected = document.getElementById("btn-delete-selected");
  if (btnDeleteSelected) {
    const isAdmin = state.currentUser && state.currentUser.role === "admin";
    if (isAdmin && count > 0) {
      btnDeleteSelected.style.display = "inline-flex";
      btnDeleteSelected.innerHTML = `<span>🗑️</span><span>حذف المحدد (${count})</span>`;
    } else {
      btnDeleteSelected.style.display = "none";
    }
  }

  const selectAll = document.getElementById("select-all-checkbox");
  if (!selectAll) return;

  const totalVisible = state.employees.length;
  if (totalVisible === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  // حساب عدد الموظفين المعروضين المحددين فعلياً في الجدول الحالي
  const selectedVisibleCount = state.employees.filter(emp => state.selectedEmployeeIds.has(emp.id)).length;

  if (selectedVisibleCount === totalVisible) {
    selectAll.checked = true;
    selectAll.indeterminate = false;
  } else if (selectedVisibleCount > 0) {
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

  // تعيين الحالة الافتراضية المحددة في خصائص الحقل
  const statusDef = state.activeFields.find(f => f.field_key === "status_id");
  let defaultStatusVal = state.defaultStatusId;
  if (statusDef && statusDef.default_value) {
    const parsed = parseInt(statusDef.default_value, 10);
    if (!isNaN(parsed) && state.statuses.some(s => s.id === parsed)) {
      defaultStatusVal = parsed;
    }
  }
  document.getElementById("emp-status-id").value = defaultStatusVal || (state.statuses[0]?.id || "");

  // تعبئة القيم الافتراضية للحقول الأساسية الأخرى إذا تم تحديدها
  const coreMap = {
    "hire_date": "emp-hire-date",
    "department": "emp-department",
    "current_grade": "emp-current-grade",
    "grade_date": "emp-grade-date",
    "education_level": "emp-education-level",
    "specialization": "emp-specialization"
  };
  Object.entries(coreMap).forEach(([fKey, inputId]) => {
    const el = document.getElementById(inputId);
    if (el) {
      const fDef = state.activeFields.find(f => f.field_key === fKey);
      el.value = (fDef && fDef.default_value) ? fDef.default_value : "";
    }
  });

  document.getElementById("emp-national-id-warning").classList.remove("visible");
  document.getElementById("btn-save-employee").disabled = false;

  renderDynamicFieldsInForm({}, true);
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

    renderDynamicFieldsInForm(emp.custom_values || {}, false);
    openModal("modal-employee-form");
  } else {
    showToast("تعذر جلب تفاصيل الموظف", "error");
  }
}

function renderDynamicFieldsInForm(valuesMap, isNew = false) {
  const container = document.getElementById("dynamic-fields-container");
  const section = document.getElementById("dynamic-fields-section");
  container.innerHTML = "";

  const coreKeys = new Set([
    "national_id", "full_name", "status_id", "hire_date", 
    "department", "current_grade", "grade_date", "education_level", "specialization"
  ]);

  const customFields = (state.activeFields || []).filter(f => !coreKeys.has(f.field_key));

  if (customFields.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  customFields.forEach(f => {
    const div = document.createElement("div");
    div.className = "form-group";
    const rawVal = valuesMap[f.field_key];
    const val = (rawVal !== undefined && rawVal !== null) ? rawVal : (isNew ? (f.default_value || "") : "");

    let inputHtml = "";
    if (f.data_type === "select") {
      const opts = (f.options || "").split(/[\n,،]/).map(o => o.trim()).filter(Boolean);
      let optionsMarkup = `<option value="">-- اختر ${escapeHtml(f.label)} --</option>`;
      opts.forEach(opt => {
        const isSel = (opt === String(val).trim()) ? "selected" : "";
        optionsMarkup += `<option value="${escapeHtml(opt)}" ${isSel}>${escapeHtml(opt)}</option>`;
      });
      inputHtml = `
        <select id="custom-field-${f.field_key}" class="input-control custom-field-input" data-key="${f.field_key}">
          ${optionsMarkup}
        </select>
      `;
    } else if (f.data_type === "number") {
      inputHtml = `
        <input type="number" id="custom-field-${f.field_key}" class="input-control custom-field-input" data-key="${f.field_key}" value="${escapeHtml(val)}" ${f.min_length ? `minlength="${f.min_length}"` : ""} ${f.max_length ? `maxlength="${f.max_length}"` : ""}>
      `;
    } else if (f.data_type === "date") {
      inputHtml = `
        <input type="date" id="custom-field-${f.field_key}" class="input-control custom-field-input" data-key="${f.field_key}" value="${escapeHtml(val)}">
      `;
    } else {
      inputHtml = `
        <input type="text" id="custom-field-${f.field_key}" class="input-control custom-field-input" data-key="${f.field_key}" value="${escapeHtml(val)}" ${f.min_length ? `minlength="${f.min_length}"` : ""} ${f.max_length ? `maxlength="${f.max_length}"` : ""}>
      `;
    }

    div.innerHTML = `
      <label for="custom-field-${f.field_key}">${escapeHtml(f.label)}</label>
      ${inputHtml}
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

  // التحقق من قيود الحد الأدنى والأقصى للحقول المحددة في النظام
  const allFieldValues = { ...empData, ...customValues };
  for (const f of state.activeFields) {
    const val = allFieldValues[f.field_key];
    if (val !== undefined && val !== null) {
      const valStr = String(val).trim();
      if (valStr.length > 0) {
        if (f.min_length !== null && f.min_length !== undefined && valStr.length < f.min_length) {
          showAlert(`قيمة حقل [${f.label}] يجب ألا تقل عن (${f.min_length}) حرف/رقم`);
          return;
        }
        if (f.max_length !== null && f.max_length !== undefined && valStr.length > f.max_length) {
          showAlert(`قيمة حقل [${f.label}] يجب ألا تزيد عن (${f.max_length}) حرف/رقم`);
          return;
        }
      }
    }
  }

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

let customConfirmCallback = null;

function promptPermanentDelete(empId, empName) {
  state.pendingDeleteId = empId;
  customConfirmCallback = null;
  document.getElementById("confirm-modal-title").innerText = "تحذير: حذف نهائي";
  document.getElementById("confirm-modal-text").innerText =
    `تحذير: سيتم حذف هذا السجل نهائياً من قاعدة البيانات للموظف [${empName}]. هل تريد المتابعة؟`;
  openModal("modal-confirm");
}

function showCustomConfirm(title, message, onProceed) {
  state.pendingDeleteId = null;
  customConfirmCallback = onProceed;
  document.getElementById("confirm-modal-title").innerText = title;
  document.getElementById("confirm-modal-text").innerText = message;
  openModal("modal-confirm");
}

document.getElementById("btn-confirm-proceed").addEventListener("click", async () => {
  if (customConfirmCallback) {
    const cb = customConfirmCallback;
    customConfirmCallback = null;
    closeModal("modal-confirm");
    await cb();
    return;
  }

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
  customConfirmCallback = null;
  closeModal("modal-confirm");
});

// زر الحذف الجماعي للسجلات المحددة (صلاحية مدير النظام فقط)
const btnDeleteSelected = document.getElementById("btn-delete-selected");
if (btnDeleteSelected) {
  btnDeleteSelected.addEventListener("click", () => {
    const count = state.selectedEmployeeIds.size;
    if (count === 0) {
      showAlert("يرجى تحديد سجل واحد على الأقل لحذفه.");
      return;
    }

    if (!state.currentUser || state.currentUser.role !== "admin") {
      showAlert("عذراً، عملية حذف السجلات مخصصة لمدير النظام فقط");
      return;
    }

    const selectedIds = Array.from(state.selectedEmployeeIds);
    showCustomConfirm(
      "تحذير: حذف جماعي نهائي",
      `تحذير أمني: أنت على وشك حذف عدد (${count}) سجل نهائياً من قاعدة البيانات.\n\nهل أنت متأكد من رغبتك في المتابعة؟ لن يمكن التراجع عن هذا الإجراء إلا باسترجاع نسخة احتياطية.`,
      async () => {
        const api = getAPI();
        const res = await api.delete_employees_batch(selectedIds);
        if (res.success) {
          showToast(res.message || `تم حذف (${res.deleted_count || count}) سجل بنجاح`);
          state.selectedEmployeeIds.clear();
          await loadEmployees();
        } else {
          showAlert(res.error || "تعذر إتمام الحذف الجماعي");
        }
      }
    );
  });
}

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

// ==================== معالجات تصدير واستيراد الإكسل ====================

async function handleExcelExportAction() {
  const name = document.getElementById("search-name").value.trim();
  const nationalId = document.getElementById("search-national-id").value.trim();
  const statusId = document.getElementById("filter-status").value;
  const selectedIds = state.selectedEmployeeIds.size > 0 ? Array.from(state.selectedEmployeeIds) : null;

  const api = getAPI();
  const res = await api.export_excel(name, nationalId, statusId, selectedIds);

  if (res.success) {
    showToast(res.message || "تم تصدير ملف الإكسل بنجاح");
    closeModal("modal-data-hub");
  } else if (!res.cancelled) {
    showAlert(res.error || "تعذر تصدير ملف الإكسل");
  }
}

const btnOldExportExcel = document.getElementById("btn-export-excel");
if (btnOldExportExcel) {
  btnOldExportExcel.addEventListener("click", handleExcelExportAction);
}

// معالج استيراد الإكسل (خطوة بخطوة)
const btnOldImportExcel = document.getElementById("btn-import-excel");
if (btnOldImportExcel) {
  btnOldImportExcel.addEventListener("click", () => {
    resetImportWizard();
    openModal("modal-excel-import");
  });
}

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

// ==================== مركز إدارة وتصدير البيانات والنسخ الاحتياطي (Data Hub) ====================

function switchDataHubTab(tabName) {
  const isExport = tabName === "export";
  const contentExport = document.getElementById("hub-tab-content-export");
  const contentImport = document.getElementById("hub-tab-content-import");
  const btnExport = document.getElementById("hub-tab-btn-export");
  const btnImport = document.getElementById("hub-tab-btn-import");

  if (contentExport) contentExport.style.display = isExport ? "flex" : "none";
  if (contentImport) contentImport.style.display = isExport ? "none" : "flex";

  if (btnExport) btnExport.className = isExport ? "btn btn-sm btn-blue" : "btn btn-sm btn-outline";
  if (btnImport) btnImport.className = isExport ? "btn btn-sm btn-outline" : "btn btn-sm btn-blue";
}

function openDataHubModal() {
  const isAdmin = state.currentUser?.role === "admin";

  // تحديث نص تلميح التصدير بناءً على حالة التحديد الحالية
  const hintEl = document.getElementById("hub-export-target-hint");
  if (hintEl) {
    if (state.selectedEmployeeIds.size > 0) {
      hintEl.innerText = `المستهدف بالتصدير: السجلات المحددة حالياً (${state.selectedEmployeeIds.size} موظف)`;
    } else {
      hintEl.innerText = `المستهدف بالتصدير: كافة نتائج البحث المعروضة (${state.employees.length} موظف)`;
    }
  }

  // ضبط ظهور بطاقات الاستيراد والاسترجاع بحسب الصلاحيات
  document.querySelectorAll("#modal-data-hub .admin-only").forEach(el => {
    el.style.display = isAdmin ? "" : "none";
  });
  document.querySelectorAll("#modal-data-hub .staff-only").forEach(el => {
    el.style.display = isAdmin ? "none" : "block";
  });

  switchDataHubTab("export");
  openModal("modal-data-hub");
}

const btnOpenDataHub = document.getElementById("btn-open-data-hub");
if (btnOpenDataHub) {
  btnOpenDataHub.addEventListener("click", openDataHubModal);
}

const hubTabBtnExport = document.getElementById("hub-tab-btn-export");
if (hubTabBtnExport) {
  hubTabBtnExport.addEventListener("click", () => switchDataHubTab("export"));
}

const hubTabBtnImport = document.getElementById("hub-tab-btn-import");
if (hubTabBtnImport) {
  hubTabBtnImport.addEventListener("click", () => switchDataHubTab("import"));
}

// أزرار العمليات داخل مركز البيانات الموحد
const btnHubExportExcel = document.getElementById("btn-hub-export-excel");
if (btnHubExportExcel) {
  btnHubExportExcel.addEventListener("click", handleExcelExportAction);
}

const btnHubExportWord = document.getElementById("btn-hub-export-word");
if (btnHubExportWord) {
  btnHubExportWord.addEventListener("click", () => {
    // إذا لم يكن هناك تحديد، تحديد كافة الموظفين المعروضين تلقائياً لتسهيل العمل على المستخدم
    if (state.selectedEmployeeIds.size === 0) {
      if (state.employees.length === 0) {
        showAlert("لا توجد سجلات حالية لتصديرها كملف وورد");
        return;
      }
      state.employees.forEach(emp => state.selectedEmployeeIds.add(emp.id));
      updateSelectedCounter();
      syncSelectAllCheckbox();
      showToast(`تم تحديد كافة السجلات المعروضة (${state.employees.length}) تلقائياً لتصدير الوورد`, "info");
    }
    closeModal("modal-data-hub");
    openModal("modal-print-setup");
  });
}

const btnHubBackupDb = document.getElementById("btn-hub-backup-db");
if (btnHubBackupDb) {
  btnHubBackupDb.addEventListener("click", async () => {
    if (state.currentUser?.role !== "admin") {
      showAlert("أخذ النسخ الاحتياطية مخصص لمدير النظام فقط");
      return;
    }
    const api = getAPI();
    const res = await api.backup_database();
    if (res.success) {
      showToast(res.message || "تم حفظ النسخة الاحتياطية بنجاح");
      closeModal("modal-data-hub");
    } else if (!res.cancelled) {
      showAlert(res.error || "فشل إنشاء النسخة الاحتياطية");
    }
  });
}

const btnHubImportExcel = document.getElementById("btn-hub-import-excel");
if (btnHubImportExcel) {
  btnHubImportExcel.addEventListener("click", () => {
    if (state.currentUser?.role !== "admin") {
      showAlert("استيراد السجلات مخصص لمدير النظام فقط");
      return;
    }
    closeModal("modal-data-hub");
    resetImportWizard();
    openModal("modal-excel-import");
  });
}

const btnHubRestoreDb = document.getElementById("btn-hub-restore-db");
if (btnHubRestoreDb) {
  btnHubRestoreDb.addEventListener("click", async () => {
    if (state.currentUser?.role !== "admin") {
      showAlert("استرجاع النسخ الاحتياطية مخصص لمدير النظام فقط");
      return;
    }
    const api = getAPI();
    const res = await api.restore_database();
    if (res.success) {
      showToast(res.message || "تم استرجاع النسخة الاحتياطية بنجاح");
      closeModal("modal-data-hub");
      await reloadSystemData();
    } else if (!res.cancelled) {
      showAlert(res.error || "تعذر استرجاع النسخة الاحتياطية");
    }
  });
}

// مواءمة الأزرار القديمة (توافقية)
const btnOldBackupDb = document.getElementById("btn-backup-db");
if (btnOldBackupDb) {
  btnOldBackupDb.addEventListener("click", async () => {
    const api = getAPI();
    const res = await api.backup_database();
    if (res.success) showToast(res.message || "تم حفظ النسخة الاحتياطية بنجاح");
    else if (!res.cancelled) showAlert(res.error || "فشل إنشاء النسخة الاحتياطية");
  });
}

const btnOldRestoreDb = document.getElementById("btn-restore-db");
if (btnOldRestoreDb) {
  btnOldRestoreDb.addEventListener("click", async () => {
    const api = getAPI();
    const res = await api.restore_database();
    if (res.success) {
      showToast(res.message || "تم استرجاع النسخة الاحتياطية بنجاح");
      await reloadSystemData();
    } else if (!res.cancelled) showAlert(res.error || "تعذر استرجاع النسخة الاحتياطية");
  });
}

// ==================== إدارة إعدادات النظام الموحدة (Settings & Users) ====================

function switchToSettingsTab(tabName) {
  const isAdmin = state.currentUser?.role === "admin";

  // حماية صارمة: منع غير المديرين من الوصول لتبويب إدارة المستخدمين
  if (tabName === "users" && !isAdmin) {
    tabName = "fields";
  }

  const isFields = tabName === "fields";
  const isUsers = tabName === "users";

  const contentFields = document.getElementById("tab-content-fields");
  const contentUsers = document.getElementById("tab-content-users");

  if (contentFields) contentFields.style.display = isFields ? "block" : "none";
  if (contentUsers) contentUsers.style.display = isUsers ? "block" : "none";

  const btnFields = document.getElementById("tab-btn-fields");
  const btnUsers = document.getElementById("tab-btn-users");

  if (btnFields) btnFields.className = isFields ? "btn btn-sm btn-blue" : "btn btn-sm btn-outline";
  if (btnUsers) {
    btnUsers.className = isUsers ? "btn btn-sm btn-blue" : "btn btn-sm btn-outline";
    btnUsers.style.display = isAdmin ? "" : "none";
  }
}

const btnOpenSettings = document.getElementById("btn-open-settings");
if (btnOpenSettings) {
  btnOpenSettings.addEventListener("click", () => {
    const isAdmin = state.currentUser?.role === "admin";
    // المدير يدخل على تبويب المستخدمين أولاً، والموظف العادي يدخل على إدارة الحقول
    const defaultTab = isAdmin ? "users" : "fields";
    switchToSettingsTab(defaultTab);
    loadSettingsData();
    openModal("modal-settings");
  });
}

const btnOpenUsers = document.getElementById("btn-open-users");
if (btnOpenUsers) {
  btnOpenUsers.addEventListener("click", () => {
    if (state.currentUser?.role !== "admin") return;
    switchToSettingsTab("users");
    loadSettingsData();
    openModal("modal-settings");
  });
}

const tabBtnFields = document.getElementById("tab-btn-fields");
if (tabBtnFields) {
  tabBtnFields.addEventListener("click", () => switchToSettingsTab("fields"));
}

const tabBtnUsers = document.getElementById("tab-btn-users");
if (tabBtnUsers) {
  tabBtnUsers.addEventListener("click", () => switchToSettingsTab("users"));
}

async function loadSettingsData() {
  const api = getAPI();
  const isAdmin = state.currentUser?.role === "admin";

  const [fieldsRes, statusesRes, usersRes] = await Promise.all([
    api.get_all_fields(),
    api.get_all_statuses(),
    (isAdmin && api.get_users_management) ? api.get_users_management() : Promise.resolve({ success: false })
  ]);

  if (fieldsRes.success) {
    state.allFields = fieldsRes.fields || [];
    renderSettingsFields();
  }
  if (statusesRes.success) {
    state.allStatuses = statusesRes.statuses || [];
  }
  if (usersRes.success && isAdmin) {
    state.allUsers = usersRes.users || [];
    renderSettingsUsers();
  }
}

function renderSettingsFields() {
  const tbody = document.getElementById("fields-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const sortedFields = [...state.allFields].sort((a, b) => (a.display_order - b.display_order) || (a.id - b.id));

  const typeLabels = {
    "text": "نص عادي",
    "number": "أرقام فقط",
    "date": "تاريخ",
    "select": "قائمة منسدلة"
  };

  sortedFields.forEach(f => {
    const isProtected = (f.is_system === 1) || (f.field_key === "national_id" || f.field_key === "full_name");
    const isStrictIdentity = (f.field_key === "national_id" || f.field_key === "full_name");

    let constraintsText = "-";
    if (f.data_type === "select" || f.field_key === "status_id") {
      const opts = (f.options || "").split(/[\n,،]/).map(o => o.trim()).filter(Boolean);
      constraintsText = opts.length > 0 ? `(${opts.length} خيارات)` : "بدون خيارات";
    } else {
      const parts = [];
      if (f.min_length !== null && f.min_length !== undefined) parts.push(`أدنى: ${f.min_length}`);
      if (f.max_length !== null && f.max_length !== undefined) parts.push(`أقصى: ${f.max_length}`);
      if (parts.length > 0) constraintsText = parts.join(" | ");
    }

    let defaultValueDisplay = "-";
    if (f.field_key === "status_id" && f.default_value) {
      const matchedStatus = state.allStatuses.find(s => String(s.id) === String(f.default_value) || s.name === String(f.default_value));
      defaultValueDisplay = matchedStatus ? matchedStatus.name : f.default_value;
    } else if (f.default_value) {
      defaultValueDisplay = f.default_value;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align: center; font-weight: 700; font-size: 14px; color: var(--primary-navy);">
        ${f.display_order}
      </td>
      <td style="font-weight: 600; color: #1E293B;">
        ${escapeHtml(f.label)}
        ${isProtected ? `<span style="font-size: 11px; color: var(--text-muted); display: block;">(حقل أساسي)</span>` : ""}
      </td>
      <td style="font-family: monospace; font-size: 12.5px; color: #475569;">${escapeHtml(f.field_key)}</td>
      <td>
        <span class="badge-type">${typeLabels[f.data_type] || f.data_type}</span>
      </td>
      <td style="font-size: 12px; color: #475569;">${escapeHtml(constraintsText)}</td>
      <td style="font-size: 12.5px;">${escapeHtml(defaultValueDisplay)}</td>
      <td>
        <span class="status-badge ${f.is_active ? 'status-active' : 'status-absent'}">
          ${f.is_active ? 'نشط' : 'معطل'}
        </span>
      </td>
      <td style="text-align: center; white-space: nowrap;">
        <div class="table-actions" style="justify-content: center; gap: 4px;">
          <button class="btn btn-sm btn-outline" onclick="editFieldFromSettings(${f.id})" title="تعديل خصائص الحقل">
            ✏️
          </button>
          ${isStrictIdentity ? `
            <button class="btn btn-sm btn-outline" disabled title="حقل هوية أساسي محمي من الحذف أو التعطيل" style="opacity: 0.6; cursor: not-allowed;">
              🛡️ محمي
            </button>
          ` : `
            <button class="btn btn-sm ${f.is_active ? 'btn-red' : 'btn-green'}" onclick="toggleFieldStatus(${f.id}, ${f.is_active ? 0 : 1})" title="${f.is_active ? 'تعطيل الحقل' : 'تفعيل الحقل'}">
              ${f.is_active ? 'تعطيل' : 'تفعيل'}
            </button>
            ${isProtected ? `
              <button class="btn btn-sm btn-outline" disabled title="حقل نظام أساسي محمي من الحذف" style="opacity: 0.6; cursor: not-allowed;">
                🛡️
              </button>
            ` : `
              <button class="btn btn-sm btn-red" onclick="deleteFieldFromSettings(${f.id}, '${escapeHtml(f.label)}')" title="حذف الحقل">
                🗑️
              </button>
            `}
          `}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDefaultValueControl(targetVal = null) {
  const wrapper = document.getElementById("default-val-wrapper");
  if (!wrapper) return;

  const typeEl = document.getElementById("new-field-type");
  const currentType = typeEl ? typeEl.value : "text";
  const keyEl = document.getElementById("new-field-key");
  const currentKey = (keyEl ? keyEl.value : "").trim().toLowerCase();

  const optionsContainer = document.getElementById("field-options-container");
  if (optionsContainer) {
    optionsContainer.style.display = (currentType === "select") ? "block" : "none";
  }

  // الاحتفاظ بالقيمة المحددة حالياً إذا لم تُمرر قيمة صريحة
  let currentVal = targetVal;
  if (currentVal === null || currentVal === undefined) {
    const existingEl = document.getElementById("new-field-default-val");
    currentVal = existingEl ? existingEl.value : "";
  }
  const strVal = (currentVal !== null && currentVal !== undefined) ? String(currentVal).trim() : "";

  if (currentType === "select") {
    let optionsHtml = '<option value="">-- بدون قيمة افتراضية --</option>';

    // استخراج الخيارات من حقل خيارات القائمة
    const optsInput = document.getElementById("new-field-options");
    const rawText = optsInput ? optsInput.value : "";
    let items = rawText.split(/[,،\n]/).map(s => s.trim()).filter(Boolean);

    // إذا كان الحقل هو status_id ولم تُكتب خيارات بعد، نستعين بالحالات المسجلة
    if (currentKey === "status_id" && items.length === 0) {
      const statuses = (state.allStatuses && state.allStatuses.length > 0) ? state.allStatuses : (state.statuses || []);
      items = statuses.map(s => s.name);
    }

    items.forEach(item => {
      let isSelected = false;
      if (currentKey === "status_id") {
        const matched = (state.allStatuses || []).find(s => s.name === item);
        if (matched && (String(matched.id) === strVal || matched.name === strVal)) {
          isSelected = true;
        } else if (item === strVal) {
          isSelected = true;
        }
      } else {
        isSelected = (strVal === item);
      }
      optionsHtml += `<option value="${escapeHtml(item)}" ${isSelected ? "selected" : ""}>${escapeHtml(item)}</option>`;
    });

    wrapper.innerHTML = `<select id="new-field-default-val" class="input-control">${optionsHtml}</select>`;
  } else if (currentType === "number") {
    wrapper.innerHTML = `<input type="number" id="new-field-default-val" class="input-control" placeholder="رقم مبدئي..." value="${escapeHtml(strVal)}">`;
  } else if (currentType === "date") {
    wrapper.innerHTML = `<input type="date" id="new-field-default-val" class="input-control" value="${escapeHtml(strVal)}">`;
  } else {
    wrapper.innerHTML = `<input type="text" id="new-field-default-val" class="input-control" placeholder="القيمة المبدئية..." value="${escapeHtml(strVal)}">`;
  }
}

// مراقبة تغيير نوع الحقل والخيارات لتحديث حقل القيمة الافتراضية فورياً
const newFieldTypeEl = document.getElementById("new-field-type");
if (newFieldTypeEl) {
  newFieldTypeEl.addEventListener("change", () => {
    renderDefaultValueControl("");
  });
}

const newFieldOptsEl = document.getElementById("new-field-options");
if (newFieldOptsEl) {
  newFieldOptsEl.addEventListener("input", () => {
    const typeEl = document.getElementById("new-field-type");
    if (typeEl && typeEl.value === "select") {
      const currentSelected = document.getElementById("new-field-default-val")?.value || "";
      renderDefaultValueControl(currentSelected);
    }
  });
}

window.editFieldFromSettings = function(fieldId) {
  const f = state.allFields.find(field => field.id === fieldId);
  if (!f) return;

  const idInput = document.getElementById("field-edit-id");
  if (idInput) idInput.value = f.id;

  const titleEl = document.getElementById("field-form-title");
  if (titleEl) titleEl.innerText = `✏️ تعديل خصائص الحقل: ${f.label}`;

  const keyInput = document.getElementById("new-field-key");
  const hintEl = document.getElementById("field-key-hint");
  if (keyInput) {
    keyInput.value = f.field_key;
    if (f.is_system === 1 || f.field_key === "national_id" || f.field_key === "full_name") {
      keyInput.disabled = true;
      if (hintEl) hintEl.innerText = "حقل نظام أساسي محمي (لا يمكن تغيير المفتاح البرمجي)";
    } else {
      keyInput.disabled = false;
      if (hintEl) hintEl.innerText = "أحرف إنجليزية وأرقام وشرطة سفلية فقط";
    }
  }

  const labelInput = document.getElementById("new-field-label");
  if (labelInput) labelInput.value = f.label || "";

  const typeInput = document.getElementById("new-field-type");
  if (typeInput) {
    typeInput.value = f.data_type || "text";
    // الحقول الأساسية للنظام محددة النوع برمجياً
    if (f.is_system === 1 || f.field_key === "status_id" || f.field_key === "national_id" || f.field_key === "full_name") {
      typeInput.disabled = true;
    } else {
      typeInput.disabled = false;
    }
  }

  const minInput = document.getElementById("new-field-min-length");
  if (minInput) minInput.value = (f.min_length !== null && f.min_length !== undefined) ? f.min_length : "";

  const maxInput = document.getElementById("new-field-max-length");
  if (maxInput) maxInput.value = (f.max_length !== null && f.max_length !== undefined) ? f.max_length : "";

  const orderInput = document.getElementById("new-field-order");
  if (orderInput) orderInput.value = f.display_order || 0;

  const optsInput = document.getElementById("new-field-options");
  const optsHint = document.getElementById("field-options-hint");
  if (optsInput) {
    if (f.field_key === "status_id") {
      // إظهار الخيارات الحالية للحالة الوظيفية مع إمكانية تعديلها وإضافة خيارات جديدة كأي حقل آخر
      const statuses = (state.allStatuses && state.allStatuses.length > 0) ? state.allStatuses : (state.statuses || []);
      optsInput.value = f.options ? f.options : statuses.map(s => s.name).join("، ");
      optsInput.readOnly = false;
      optsInput.style.backgroundColor = "";
      if (optsHint) optsHint.style.display = "none";
    } else {
      optsInput.value = f.options || "";
      optsInput.readOnly = false;
      optsInput.style.backgroundColor = "";
      if (optsHint) optsHint.style.display = "none";
    }
  }

  // بناء حقل القيمة الافتراضية بحسب نوع الحقل مع تحديد قيمته
  renderDefaultValueControl(f.default_value || "");

  const cancelBtn = document.getElementById("btn-cancel-edit-field");
  if (cancelBtn) cancelBtn.style.display = "inline-flex";

  const formBox = document.getElementById("field-form-box");
  if (formBox) formBox.scrollIntoView({ behavior: "smooth" });
};

function resetFieldForm() {
  const idInput = document.getElementById("field-edit-id");
  if (idInput) idInput.value = "";

  const titleEl = document.getElementById("field-form-title");
  if (titleEl) titleEl.innerText = "➕ إضافة حقل جديد للسجلات:";

  const keyInput = document.getElementById("new-field-key");
  const hintEl = document.getElementById("field-key-hint");
  if (keyInput) {
    keyInput.disabled = false;
    keyInput.value = "";
  }
  if (hintEl) hintEl.innerText = "أحرف إنجليزية وأرقام وشرطة سفلية فقط";

  const labelInput = document.getElementById("new-field-label");
  if (labelInput) labelInput.value = "";

  const typeInput = document.getElementById("new-field-type");
  if (typeInput) {
    typeInput.disabled = false;
    typeInput.value = "text";
  }

  const minInput = document.getElementById("new-field-min-length");
  if (minInput) minInput.value = "";

  const maxInput = document.getElementById("new-field-max-length");
  if (maxInput) maxInput.value = "";

  const orderInput = document.getElementById("new-field-order");
  if (orderInput) orderInput.value = "0";

  const optsInput = document.getElementById("new-field-options");
  const optsHint = document.getElementById("field-options-hint");
  if (optsInput) {
    optsInput.value = "";
    optsInput.readOnly = false;
    optsInput.style.backgroundColor = "";
  }
  if (optsHint) optsHint.style.display = "none";

  renderDefaultValueControl("");

  const cancelBtn = document.getElementById("btn-cancel-edit-field");
  if (cancelBtn) cancelBtn.style.display = "none";
}

const btnCancelEditField = document.getElementById("btn-cancel-edit-field");
if (btnCancelEditField) {
  btnCancelEditField.addEventListener("click", resetFieldForm);
}

const btnSaveFieldSubmit = document.getElementById("btn-save-field-submit");
if (btnSaveFieldSubmit) {
  btnSaveFieldSubmit.addEventListener("click", async () => {
    const editIdVal = document.getElementById("field-edit-id")?.value.trim() || "";
    const fieldId = editIdVal ? parseInt(editIdVal, 10) : null;
    const key = (document.getElementById("new-field-key")?.value || "").trim().toLowerCase();
    const label = (document.getElementById("new-field-label")?.value || "").trim();
    const dataType = document.getElementById("new-field-type")?.value || "text";
    const minLenVal = (document.getElementById("new-field-min-length")?.value || "").trim();
    const maxLenVal = (document.getElementById("new-field-max-length")?.value || "").trim();
    const orderVal = (document.getElementById("new-field-order")?.value || "").trim();
    const defaultVal = (document.getElementById("new-field-default-val")?.value || "").trim();
    const optionsVal = (document.getElementById("new-field-options")?.value || "").trim();

    if (!fieldId && !key) {
      showAlert("يرجى إدخال المفتاح البرمجي للحقل الجديد");
      return;
    }

    if (!label) {
      showAlert("يرجى إدخال التسمية المعروضة للحقل");
      return;
    }

    const minLength = minLenVal !== "" ? parseInt(minLenVal, 10) : null;
    const maxLength = maxLenVal !== "" ? parseInt(maxLenVal, 10) : null;
    const displayOrder = orderVal !== "" ? parseInt(orderVal, 10) : 0;

    if (minLength !== null && maxLength !== null && minLength > maxLength) {
      showAlert("الحد الأدنى للأحرف لا يمكن أن يتجاوز الحد الأقصى");
      return;
    }

    const payload = {
      id: fieldId,
      field_key: key,
      label: label,
      data_type: dataType,
      min_length: minLength,
      max_length: maxLength,
      options: optionsVal,
      default_value: defaultVal,
      display_order: displayOrder
    };

    const api = getAPI();
    const res = await api.save_field(payload);
    if (res.success) {
      showToast(res.message || "تم حفظ خصائص الحقل بنجاح");
      resetFieldForm();
      await loadSettingsData();

      // تحديث قائمة الحقول النشطة والحالات ورأس وقيم الجدول الرئيسي
      const initRes = await api.get_initial_data();
      if (initRes.success) {
        state.activeFields = initRes.active_fields || [];
        state.statuses = initRes.statuses || [];
        const statusFieldDef = state.activeFields.find(f => f.field_key === "status_id");
        if (statusFieldDef && statusFieldDef.default_value && state.statuses.some(s => String(s.id) === String(statusFieldDef.default_value))) {
          state.defaultStatusId = parseInt(statusFieldDef.default_value, 10);
        }
      }
      populateStatusDropdowns();
      renderEmployeesTableHeader();
      renderEmployeesTable();
    } else {
      showAlert(res.error || "تعذر حفظ الحقل");
    }
  });
}

window.deleteFieldFromSettings = async function(fieldId, fieldLabel) {
  const f = state.allFields.find(field => field.id === fieldId);
  if (f && (f.is_system === 1 || f.field_key === "national_id" || f.field_key === "full_name")) {
    showAlert(`عذراً، لا يمكن حذف الحقل الأساسي [${fieldLabel}] لأنه حقل محمي للنظام`);
    return;
  }

  showCustomConfirm(
    "تأكيد حذف الحقل",
    `هل أنت متأكد من رغبتك في حذف الحقل المخصص [${fieldLabel}] نهائياً؟ سيتم حذف أي بيانات مدخلة لهذا الحقل في سجلات الموظفين.`,
    async () => {
      const api = getAPI();
      const res = await api.delete_field(fieldId);
      if (res.success) {
        showToast(res.message || "تم حذف الحقل بنجاح");
        if (document.getElementById("field-edit-id")?.value === String(fieldId)) {
          resetFieldForm();
        }
        await loadSettingsData();
        const initRes = await api.get_initial_data();
        if (initRes.success) {
          state.activeFields = initRes.active_fields || [];
        }
        renderEmployeesTableHeader();
        renderEmployeesTable();
      } else {
        showAlert(res.error || "تعذر حذف الحقل");
      }
    }
  );
};

window.toggleFieldStatus = async function(fieldId, targetActive) {
  const f = state.allFields.find(field => field.id === fieldId);
  if (f && (f.is_system === 1 || f.field_key === "national_id" || f.field_key === "full_name") && targetActive === 0) {
    showAlert(`لا يمكن تعطيل الحقل الأساسي [${f.label}]`);
    return;
  }

  const api = getAPI();
  const res = await api.toggle_field(fieldId, targetActive);
  if (res.success) {
    showToast("تم تحديث حالة تفعيل الحقل");
    await loadSettingsData();
    const initRes = await api.get_initial_data();
    if (initRes.success) {
      state.activeFields = initRes.active_fields || [];
      state.statuses = initRes.statuses || [];
      const statusFieldDef = state.activeFields.find(f => f.field_key === "status_id");
      if (statusFieldDef && statusFieldDef.default_value && state.statuses.some(s => String(s.id) === String(statusFieldDef.default_value))) {
        state.defaultStatusId = parseInt(statusFieldDef.default_value, 10);
      }
    }
    populateStatusDropdowns();
    renderEmployeesTableHeader();
    renderEmployeesTable();
  } else {
    showAlert(res.error || "تعذر تغيير حالة الحقل");
  }
};

// ==================== إدارة مستخدمي النظام والصلاحيات ====================

function renderSettingsUsers() {
  const tbody = document.getElementById("users-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  (state.allUsers || []).forEach(u => {
    const tr = document.createElement("tr");
    const roleBadge = u.role === "admin"
      ? '<span class="status-badge status-active">مدير نظام</span>'
      : '<span class="status-badge" style="background: #E2E8F0; color: #334155;">موظف إدخال</span>';

    const isCurrent = state.currentUser && state.currentUser.id === u.id;
    const currentIndicator = isCurrent ? '<span style="font-size: 11px; color: var(--color-blue); margin-right: 6px;">(حسابك الحالي)</span>' : '';

    tr.innerHTML = `
      <td style="font-family: monospace; text-align: center;">${u.id}</td>
      <td style="font-weight: 600;">${escapeHtml(u.display_name)} ${currentIndicator}</td>
      <td>${roleBadge}</td>
      <td style="font-family: monospace; letter-spacing: 1px;">•••• <span style="font-size: 11px; color: #64748B;">(${escapeHtml(u.pin_code)})</span></td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 6px; justify-content: center;">
          <button class="btn btn-sm btn-outline" onclick="editUserFromSettings(${u.id})">
            ✏️ تعديل
          </button>
          <button class="btn btn-sm btn-red" onclick="deleteUserFromSettings(${u.id}, '${escapeHtml(u.display_name)}')">
            🗑️ حذف
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function resetUserForm() {
  const idEl = document.getElementById("user-mgmt-id");
  const nameEl = document.getElementById("new-user-name");
  const pinEl = document.getElementById("new-user-pin");
  const roleEl = document.getElementById("new-user-role");
  const titleEl = document.getElementById("user-form-title");
  const submitBtn = document.getElementById("btn-add-user-submit");
  const cancelBtn = document.getElementById("btn-cancel-user-edit");

  if (idEl) idEl.value = "";
  if (nameEl) nameEl.value = "";
  if (pinEl) {
    pinEl.value = "";
    pinEl.placeholder = "أرقام فقط (مثال: 5566)";
  }
  if (roleEl) roleEl.value = "staff";
  if (titleEl) titleEl.innerText = "إضافة مستخدم جديد للنظام:";
  if (submitBtn) submitBtn.innerText = "➕ إضافة المستخدم";
  if (cancelBtn) cancelBtn.style.display = "none";
}

const cancelUserEditBtn = document.getElementById("btn-cancel-user-edit");
if (cancelUserEditBtn) {
  cancelUserEditBtn.addEventListener("click", resetUserForm);
}

const addUserSubmitBtn = document.getElementById("btn-add-user-submit");
if (addUserSubmitBtn) {
  addUserSubmitBtn.addEventListener("click", async () => {
    const userId = document.getElementById("user-mgmt-id").value;
    const name = document.getElementById("new-user-name").value.trim();
    const pin = document.getElementById("new-user-pin").value.trim();
    const role = document.getElementById("new-user-role").value;

    if (!name) {
      showAlert("يرجى إدخال اسم المستخدم المعروض");
      return;
    }

    if (!userId) {
      if (!pin || pin.length < 3) {
        showAlert("يرجى إدخال رمز مرور (PIN) لا يقل عن 3 أرقام للمستخدم الجديد");
        return;
      }
    } else {
      if (pin && pin.length < 3) {
        showAlert("رمز المرور الجديد يجب ألا يقل عن 3 أرقام");
        return;
      }
    }

    const payload = {
      display_name: name,
      role: role
    };
    if (userId) {
      payload.id = parseInt(userId, 10);
    }
    if (pin) {
      payload.pin_code = pin;
    }

    const api = getAPI();
    const res = await api.save_user(payload);

    if (res.success) {
      showToast(res.message || "تم حفظ بيانات المستخدم بنجاح");
      resetUserForm();
      await loadSettingsData();

      // تحديث قائمة الدخول العامة
      const initRes = await api.get_initial_data();
      if (initRes.success) {
        state.users = initRes.users || [];
        populateLoginUsers();
      }
    } else {
      showAlert(res.error || "تعذر حفظ بيانات المستخدم");
    }
  });
}

window.editUserFromSettings = function(userId) {
  const user = (state.allUsers || []).find(u => u.id === userId);
  if (!user) return;

  document.getElementById("user-mgmt-id").value = user.id;
  document.getElementById("new-user-name").value = user.display_name;
  document.getElementById("new-user-pin").value = "";
  document.getElementById("new-user-pin").placeholder = "اتركه فارغاً للإبقاء على الرمز الحالي";
  document.getElementById("new-user-role").value = user.role;

  document.getElementById("user-form-title").innerText = `تعديل بيانات المستخدم: ${user.display_name}`;
  document.getElementById("btn-add-user-submit").innerText = "💾 حفظ التعديلات";
  document.getElementById("btn-cancel-user-edit").style.display = "inline-flex";
  document.getElementById("new-user-name").focus();
};

window.deleteUserFromSettings = function(userId, userName) {
  if (state.currentUser && state.currentUser.id === userId) {
    showAlert("عذراً، لا يمكنك حذف حسابك الحالي الذي تستخدمه لتسجيل الدخول.");
    return;
  }

  showCustomConfirm(
    "تأكيد حذف المستخدم",
    `هل أنت متأكد من رغبتك في حذف المستخدم [${userName}] من النظام نهائياً؟`,
    async () => {
      const api = getAPI();
      const res = await api.delete_user(userId);
      if (res.success) {
        showToast(res.message || "تم حذف المستخدم بنجاح");
        resetUserForm();
        await loadSettingsData();

        const initRes = await api.get_initial_data();
        if (initRes.success) {
          state.users = initRes.users || [];
          populateLoginUsers();
        }
      } else {
        showAlert(res.error || "تعذر إتمام حذف المستخدم");
      }
    }
  );
};

