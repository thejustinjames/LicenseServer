var API_URL = '';
var token = localStorage.getItem('adminToken'); // Backward compat
var adminUser = JSON.parse(localStorage.getItem('adminUser') || 'null');

// Data cache
var products = [];
var customers = [];
var categories = [];
var coupons = [];
var productSearchTimeout = null;

// Initialize
document.addEventListener('DOMContentLoaded', function() {
  bindEvents();

  // Check auth status from server (validates cookie)
  checkAuthStatus();
});

// Check authentication status
function checkAuthStatus() {
  api('/api/portal/me')
    .then(function(data) {
      if (data.isAdmin) {
        adminUser = data;
        localStorage.setItem('adminUser', JSON.stringify(adminUser));
        showAdminInterface();
        loadDashboard();
      } else {
        showSection('login');
        showAlert('loginAlert', 'Admin access required', 'error');
      }
    })
    .catch(function() {
      // Not authenticated
      if (token && adminUser) {
        // Try with stored token
        showAdminInterface();
        loadDashboard();
      } else {
        showSection('login');
      }
    });
}

// Bind Events
function bindEvents() {
  // Login form
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // Sidebar navigation
  var sidebarLinks = document.querySelectorAll('.sidebar-link');
  for (var i = 0; i < sidebarLinks.length; i++) {
    sidebarLinks[i].addEventListener('click', function(e) {
      e.preventDefault();
      var section = this.getAttribute('data-section');
      showSection(section);
      loadSectionData(section);

      // Update active state
      for (var j = 0; j < sidebarLinks.length; j++) {
        sidebarLinks[j].classList.remove('active');
      }
      this.classList.add('active');
    });
  }

  // Product modal
  document.getElementById('addProductBtn').addEventListener('click', function() {
    openProductModal();
  });
  document.getElementById('closeProductModal').addEventListener('click', closeProductModal);
  document.getElementById('cancelProductBtn').addEventListener('click', closeProductModal);
  document.getElementById('productForm').addEventListener('submit', handleProductSubmit);

  // Stripe fields toggle
  document.getElementById('createStripeProduct').addEventListener('change', function() {
    document.getElementById('stripeFields').classList.toggle('hidden', !this.checked);
  });

  // License modal
  document.getElementById('addLicenseBtn').addEventListener('click', openLicenseModal);
  document.getElementById('closeLicenseModal').addEventListener('click', closeLicenseModal);
  document.getElementById('cancelLicenseBtn').addEventListener('click', closeLicenseModal);
  document.getElementById('licenseForm').addEventListener('submit', handleLicenseSubmit);

  // Close modals on outside click
  document.getElementById('productModal').addEventListener('click', function(e) {
    if (e.target === this) closeProductModal();
  });
  document.getElementById('licenseModal').addEventListener('click', function(e) {
    if (e.target === this) closeLicenseModal();
  });

  // Product search and filter
  document.getElementById('productSearch').addEventListener('input', function() {
    clearTimeout(productSearchTimeout);
    productSearchTimeout = setTimeout(function() {
      loadProducts();
    }, 300);
  });
  document.getElementById('productCategoryFilter').addEventListener('change', function() {
    loadProducts();
  });

  // Event delegation for action buttons (prevents inline onclick XSS risk)
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.action-btn');
    if (!btn) return;

    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');

    switch (action) {
      case 'edit-product':
        editProduct(id);
        break;
      case 'delete-product':
        deleteProduct(id);
        break;
      case 'suspend-license':
        suspendLicense(id);
        break;
      case 'revoke-license':
        revokeLicense(id);
        break;
      case 'reactivate-license':
        reactivateLicense(id);
        break;
      case 'delete-coupon':
        deleteCoupon(id);
        break;
      case 'deactivate-promo':
        deactivatePromoCode(id);
        break;
      case 'activate-promo':
        activatePromoCode(id);
        break;
    }
  });

  // Coupon modal
  document.getElementById('addCouponBtn').addEventListener('click', openCouponModal);
  document.getElementById('closeCouponModal').addEventListener('click', closeCouponModal);
  document.getElementById('cancelCouponBtn').addEventListener('click', closeCouponModal);
  document.getElementById('couponForm').addEventListener('submit', handleCouponSubmit);
  document.getElementById('couponModal').addEventListener('click', function(e) {
    if (e.target === this) closeCouponModal();
  });

  // Coupon form dynamic fields
  document.getElementById('discountType').addEventListener('change', function() {
    var hint = document.getElementById('discountHint');
    var currencyGroup = document.getElementById('currencyGroup');
    if (this.value === 'percent') {
      hint.textContent = 'Percentage (1-100)';
      currencyGroup.style.display = 'none';
    } else {
      hint.textContent = 'Amount in cents (e.g., 500 = $5.00)';
      currencyGroup.style.display = 'block';
    }
  });

  document.getElementById('couponDuration').addEventListener('change', function() {
    var monthsGroup = document.getElementById('durationMonthsGroup');
    monthsGroup.style.display = this.value === 'repeating' ? 'block' : 'none';
  });

  // Promo code modal
  document.getElementById('addPromoCodeBtn').addEventListener('click', openPromoCodeModal);
  document.getElementById('closePromoCodeModal').addEventListener('click', closePromoCodeModal);
  document.getElementById('cancelPromoCodeBtn').addEventListener('click', closePromoCodeModal);
  document.getElementById('promoCodeForm').addEventListener('submit', handlePromoCodeSubmit);
  document.getElementById('promoCodeModal').addEventListener('click', function(e) {
    if (e.target === this) closePromoCodeModal();
  });

  // Promo code uppercase
  document.getElementById('promoCode').addEventListener('input', function() {
    this.value = this.value.toUpperCase();
  });

  // Tab switching
  var tabBtns = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabBtns.length; i++) {
    tabBtns[i].addEventListener('click', function() {
      var tabId = this.getAttribute('data-tab');

      // Update buttons
      var allBtns = document.querySelectorAll('.tab-btn');
      for (var j = 0; j < allBtns.length; j++) {
        allBtns[j].classList.remove('active');
      }
      this.classList.add('active');

      // Update content
      var allContent = document.querySelectorAll('.tab-content');
      for (var k = 0; k < allContent.length; k++) {
        allContent[k].classList.remove('active');
      }
      document.getElementById(tabId).classList.add('active');
    });
  }
}

// API Helper
function api(endpoint, options) {
  options = options || {};
  var headers = {
    'Content-Type': 'application/json'
  };

  // Include Authorization header as fallback (httpOnly cookie is primary auth)
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  return fetch(API_URL + endpoint, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body,
    credentials: 'include' // Send cookies with requests
  })
  .then(function(response) {
    return response.json().then(function(data) {
      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    });
  });
}

// Show Section
function showSection(sectionId) {
  var sections = document.querySelectorAll('.admin-section');
  for (var i = 0; i < sections.length; i++) {
    sections[i].classList.remove('active');
  }
  document.getElementById(sectionId).classList.add('active');
}

// Show Admin Interface
function showAdminInterface() {
  document.querySelector('.sidebar').style.display = 'block';
  document.getElementById('adminNav').classList.remove('hidden');
  document.getElementById('adminEmail').textContent = adminUser.email;
  showSection('dashboard');

  // Set first sidebar link as active
  var firstLink = document.querySelector('.sidebar-link');
  if (firstLink) firstLink.classList.add('active');
}

// Handle Login
function handleLogin(e) {
  e.preventDefault();
  var alertEl = document.getElementById('loginAlert');
  var email = document.getElementById('loginEmail').value;
  var password = document.getElementById('loginPassword').value;

  api('/api/portal/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: email, password: password })
  })
  .then(function(data) {
    if (!data.customer.isAdmin) {
      alertEl.innerHTML = '<div class="alert alert-error">Access denied. Admin privileges required.</div>';
      return;
    }

    token = data.token;
    adminUser = data.customer;
    localStorage.setItem('adminToken', token);
    localStorage.setItem('adminUser', JSON.stringify(adminUser));

    showAdminInterface();
    loadDashboard();
  })
  .catch(function(error) {
    alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(error.message) + '</div>';
  });
}

// Logout
function logout() {
  // Call server logout to invalidate token and clear cookie
  api('/api/portal/auth/logout', { method: 'POST' })
    .catch(function() {
      // Ignore errors, still clear local state
    })
    .finally(function() {
      token = null;
      adminUser = null;
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminUser');
      document.querySelector('.sidebar').style.display = 'none';
      document.getElementById('adminNav').classList.add('hidden');
      showSection('login');
    });
}

// Load Section Data
function loadSectionData(section) {
  switch (section) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'products':
      loadProducts();
      break;
    case 'licenses':
      loadLicenses();
      break;
    case 'customers':
      loadCustomers();
      break;
    case 'subscriptions':
      loadSubscriptions();
      break;
    case 'refunds':
      loadRefunds();
      break;
    case 'coupons':
      loadCoupons();
      loadPromoCodes();
      break;
  }
}

// Load Dashboard
function loadDashboard() {
  api('/api/admin/dashboard/stats')
    .then(function(data) {
      document.getElementById('statProducts').textContent = data.totalProducts;
      document.getElementById('statLicenses').textContent = data.activeLicenses;
      document.getElementById('statCustomers').textContent = data.totalCustomers;
      document.getElementById('statSubscriptions').textContent = data.activeSubscriptions;

      // Recent licenses
      var tbody = document.getElementById('recentLicensesTable');
      if (data.recentLicenses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No licenses yet</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < data.recentLicenses.length; i++) {
        var lic = data.recentLicenses[i];
        html += '<tr>';
        html += '<td><code class="license-key">' + escapeHtml(lic.key) + '</code></td>';
        html += '<td>' + escapeHtml(lic.product.name) + '</td>';
        html += '<td>' + escapeHtml(lic.customer.email) + '</td>';
        html += '<td><span class="status-badge status-' + lic.status.toLowerCase() + '">' + lic.status + '</span></td>';
        html += '<td>' + formatDate(lic.createdAt) + '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load dashboard:', error);
    });
}

// Load Products
function loadProducts() {
  var search = document.getElementById('productSearch').value;
  var category = document.getElementById('productCategoryFilter').value;

  var url = '/api/admin/products';
  var params = [];
  if (search) params.push('search=' + encodeURIComponent(search));
  if (category) params.push('category=' + encodeURIComponent(category));
  if (params.length > 0) url += '?' + params.join('&');

  api(url)
    .then(function(data) {
      products = data;
      var tbody = document.getElementById('productsTable');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b;">No products found.</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < data.length; i++) {
        var prod = data[i];
        html += '<tr>';
        html += '<td><strong>' + escapeHtml(prod.name) + '</strong></td>';
        html += '<td>' + (prod.category ? '<span class="feature-tag">' + escapeHtml(prod.category) + '</span>' : '-') + '</td>';
        html += '<td>' + escapeHtml(prod.description || '-') + '</td>';
        html += '<td><div class="features-list">';
        var features = prod.features || [];
        for (var j = 0; j < features.length && j < 3; j++) {
          html += '<span class="feature-tag">' + escapeHtml(features[j]) + '</span>';
        }
        if (features.length > 3) {
          html += '<span class="feature-tag">+' + (features.length - 3) + '</span>';
        }
        html += '</div></td>';
        html += '<td>' + (prod.stripePriceId ? '<span class="status-badge status-active">Configured</span>' : '<span class="status-badge status-suspended">Not Set</span>') + '</td>';
        html += '<td class="actions">';
        html += '<button class="btn btn-secondary btn-sm action-btn" data-action="edit-product" data-id="' + escapeHtml(prod.id) + '">Edit</button>';
        html += '<button class="btn btn-danger btn-sm action-btn" data-action="delete-product" data-id="' + escapeHtml(prod.id) + '">Delete</button>';
        html += '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load products:', error);
    });

  // Also load categories for the filter
  loadCategories();
}

// Load Categories
function loadCategories() {
  api('/api/admin/products/categories')
    .then(function(data) {
      categories = data;
      var select = document.getElementById('productCategoryFilter');
      var currentValue = select.value;

      // Keep "All Categories" option and add categories
      select.innerHTML = '<option value="">All Categories</option>';
      for (var i = 0; i < data.length; i++) {
        select.innerHTML += '<option value="' + escapeHtml(data[i]) + '">' + escapeHtml(data[i]) + '</option>';
      }

      // Restore previous selection
      select.value = currentValue;

      // Update category datalist in modal
      var datalist = document.getElementById('categoryList');
      if (datalist) {
        datalist.innerHTML = '';
        for (var j = 0; j < data.length; j++) {
          datalist.innerHTML += '<option value="' + escapeHtml(data[j]) + '">';
        }
      }
    })
    .catch(function(error) {
      console.error('Failed to load categories:', error);
    });
}

// Load Licenses
function loadLicenses() {
  api('/api/admin/licenses')
    .then(function(data) {
      var tbody = document.getElementById('licensesTable');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b;">No licenses yet</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < data.length; i++) {
        var lic = data[i];
        html += '<tr>';
        html += '<td><code class="license-key">' + escapeHtml(lic.key) + '</code></td>';
        html += '<td>' + escapeHtml(lic.product.name) + '</td>';
        html += '<td>' + escapeHtml(lic.customer.email) + '</td>';
        html += '<td><span class="status-badge status-' + lic.status.toLowerCase() + '">' + lic.status + '</span></td>';
        html += '<td>' + lic.activations.length + ' / ' + lic.maxActivations + '</td>';
        html += '<td class="actions">';
        if (lic.status === 'ACTIVE') {
          html += '<button class="btn btn-secondary btn-sm action-btn" data-action="suspend-license" data-id="' + escapeHtml(lic.id) + '">Suspend</button>';
          html += '<button class="btn btn-danger btn-sm action-btn" data-action="revoke-license" data-id="' + escapeHtml(lic.id) + '">Revoke</button>';
        } else if (lic.status === 'SUSPENDED') {
          html += '<button class="btn btn-success btn-sm action-btn" data-action="reactivate-license" data-id="' + escapeHtml(lic.id) + '">Reactivate</button>';
        }
        html += '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load licenses:', error);
    });
}

// Load Customers
function loadCustomers() {
  api('/api/admin/customers')
    .then(function(data) {
      customers = data;
      var tbody = document.getElementById('customersTable');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No customers yet</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < data.length; i++) {
        var cust = data[i];
        html += '<tr>';
        html += '<td>' + escapeHtml(cust.name || '-') + '</td>';
        html += '<td>' + escapeHtml(cust.email) + '</td>';
        html += '<td><code style="font-size: 0.8rem;">' + escapeHtml(cust.stripeCustomerId || '-') + '</code></td>';
        html += '<td>' + (cust.isAdmin ? '<span class="status-badge status-active">Yes</span>' : 'No') + '</td>';
        html += '<td>' + formatDate(cust.createdAt) + '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load customers:', error);
    });
}

// Load Subscriptions
function loadSubscriptions() {
  api('/api/admin/subscriptions')
    .then(function(data) {
      var tbody = document.getElementById('subscriptionsTable');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No subscriptions yet</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < data.length; i++) {
        var sub = data[i];
        html += '<tr>';
        html += '<td><code style="font-size: 0.8rem;">' + escapeHtml(sub.stripeSubscriptionId) + '</code></td>';
        html += '<td>' + escapeHtml(sub.customer.email) + '</td>';
        html += '<td><span class="status-badge status-' + sub.status.toLowerCase() + '">' + sub.status + '</span></td>';
        html += '<td>' + (sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : '-') + '</td>';
        html += '<td>' + (sub.cancelAtPeriodEnd ? '<span class="status-badge status-suspended">Yes</span>' : 'No') + '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load subscriptions:', error);
    });
}

// Load Refunds
function loadRefunds() {
  api('/api/admin/refunds')
    .then(function(data) {
      var tbody = document.getElementById('refundsTable');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b;">No refunds yet</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < data.length; i++) {
        var ref = data[i];
        html += '<tr>';
        html += '<td><code style="font-size: 0.8rem;">' + escapeHtml(ref.stripeRefundId) + '</code></td>';
        html += '<td>' + escapeHtml(ref.customer.email) + '</td>';
        html += '<td>$' + (ref.amount / 100).toFixed(2) + ' ' + ref.currency.toUpperCase() + '</td>';
        html += '<td><span class="status-badge status-active">' + ref.status + '</span></td>';
        html += '<td>' + (ref.licensesRevoked ? '<span class="status-badge status-expired">Yes</span>' : 'No') + '</td>';
        html += '<td>' + formatDate(ref.createdAt) + '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load refunds:', error);
    });
}

// Product Modal
function openProductModal(product) {
  document.getElementById('productModal').classList.add('active');
  document.getElementById('productForm').reset();
  document.getElementById('stripeFields').classList.add('hidden');

  // Load categories for autocomplete
  loadCategories();

  if (product) {
    document.getElementById('productModalTitle').textContent = 'Edit Product';
    document.getElementById('productId').value = product.id;
    document.getElementById('productName').value = product.name;
    document.getElementById('productDescription').value = product.description || '';
    document.getElementById('productCategory').value = product.category || '';
    document.getElementById('productFeatures').value = (product.features || []).join(', ');
    document.getElementById('licenseDuration').value = product.licenseDurationDays || '';
    document.getElementById('validationMode').value = product.validationMode || 'ONLINE';
    document.getElementById('pricingType').value = product.pricingType || 'FIXED';
    document.getElementById('s3PackageKey').value = product.s3PackageKey || '';
    document.getElementById('productVersion').value = product.version || '';
  } else {
    document.getElementById('productModalTitle').textContent = 'Add Product';
    document.getElementById('productId').value = '';
  }
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('active');
}

function editProduct(id) {
  var product = products.find(function(p) { return p.id === id; });
  if (product) {
    openProductModal(product);
  }
}

function deleteProduct(id) {
  if (!confirm('Are you sure you want to delete this product?')) return;

  api('/api/admin/products/' + id, { method: 'DELETE' })
    .then(function() {
      loadProducts();
    })
    .catch(function(error) {
      alert('Failed to delete product: ' + error.message);
    });
}

function handleProductSubmit(e) {
  e.preventDefault();

  var id = document.getElementById('productId').value;
  var features = document.getElementById('productFeatures').value
    .split(',')
    .map(function(f) { return f.trim(); })
    .filter(function(f) { return f; });

  var data = {
    name: document.getElementById('productName').value,
    description: document.getElementById('productDescription').value || undefined,
    category: document.getElementById('productCategory').value || undefined,
    features: features,
    licenseDurationDays: document.getElementById('licenseDuration').value ? parseInt(document.getElementById('licenseDuration').value) : undefined,
    validationMode: document.getElementById('validationMode').value,
    pricingType: document.getElementById('pricingType').value,
    s3PackageKey: document.getElementById('s3PackageKey').value || undefined,
    version: document.getElementById('productVersion').value || undefined
  };

  if (document.getElementById('createStripeProduct').checked && !id) {
    data.createStripeProduct = true;
    data.stripePriceAmount = parseInt(document.getElementById('stripePrice').value);
    data.stripePriceCurrency = document.getElementById('stripeCurrency').value;
    data.stripePriceInterval = document.getElementById('stripeInterval').value;
  }

  var method = id ? 'PUT' : 'POST';
  var url = id ? '/api/admin/products/' + id : '/api/admin/products';

  api(url, { method: method, body: JSON.stringify(data) })
    .then(function() {
      closeProductModal();
      loadProducts();
    })
    .catch(function(error) {
      alert('Failed to save product: ' + error.message);
    });
}

// License Modal
function openLicenseModal() {
  document.getElementById('licenseModal').classList.add('active');
  document.getElementById('licenseForm').reset();

  // Populate products dropdown
  var productSelect = document.getElementById('licenseProduct');
  productSelect.innerHTML = '<option value="">Select a product...</option>';
  for (var i = 0; i < products.length; i++) {
    productSelect.innerHTML += '<option value="' + products[i].id + '">' + escapeHtml(products[i].name) + '</option>';
  }

  // Load customers if not already loaded
  if (customers.length === 0) {
    api('/api/admin/customers')
      .then(function(data) {
        customers = data;
        populateCustomersDropdown();
      });
  } else {
    populateCustomersDropdown();
  }
}

function populateCustomersDropdown() {
  var customerSelect = document.getElementById('licenseCustomer');
  customerSelect.innerHTML = '<option value="">Select a customer...</option>';
  for (var i = 0; i < customers.length; i++) {
    customerSelect.innerHTML += '<option value="' + customers[i].id + '">' + escapeHtml(customers[i].email) + '</option>';
  }
}

function closeLicenseModal() {
  document.getElementById('licenseModal').classList.remove('active');
}

function handleLicenseSubmit(e) {
  e.preventDefault();

  var data = {
    productId: document.getElementById('licenseProduct').value,
    customerId: document.getElementById('licenseCustomer').value,
    maxActivations: parseInt(document.getElementById('licenseMaxActivations').value) || 1
  };

  var expiry = document.getElementById('licenseExpiry').value;
  if (expiry) {
    data.expiresAt = new Date(expiry).toISOString();
  }

  api('/api/admin/licenses', { method: 'POST', body: JSON.stringify(data) })
    .then(function(license) {
      closeLicenseModal();
      loadLicenses();
      alert('License created: ' + license.key);
    })
    .catch(function(error) {
      alert('Failed to create license: ' + error.message);
    });
}

// License Actions
function suspendLicense(id) {
  if (!confirm('Suspend this license?')) return;
  api('/api/admin/licenses/' + id + '/suspend', { method: 'POST' })
    .then(function() { loadLicenses(); })
    .catch(function(error) { alert('Failed: ' + error.message); });
}

function revokeLicense(id) {
  if (!confirm('Revoke this license? This action cannot be undone.')) return;
  api('/api/admin/licenses/' + id + '/revoke', { method: 'POST' })
    .then(function() { loadLicenses(); })
    .catch(function(error) { alert('Failed: ' + error.message); });
}

function reactivateLicense(id) {
  api('/api/admin/licenses/' + id + '/reactivate', { method: 'POST' })
    .then(function() { loadLicenses(); })
    .catch(function(error) { alert('Failed: ' + error.message); });
}

// Helpers
function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  var date = new Date(dateStr);
  return date.toLocaleDateString();
}

// ============================================================================
// COUPONS
// ============================================================================

function loadCoupons() {
  api('/api/admin/coupons')
    .then(function(response) {
      coupons = response.data || [];
      var tbody = document.getElementById('couponsTable');

      if (coupons.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b;">No coupons yet. Create one to get started!</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < coupons.length; i++) {
        var coupon = coupons[i];
        var discount = coupon.percent_off
          ? coupon.percent_off + '% off'
          : formatCurrency(coupon.amount_off, coupon.currency) + ' off';

        var duration = coupon.duration;
        if (coupon.duration === 'repeating') {
          duration = coupon.duration_in_months + ' months';
        }

        var redeemed = coupon.times_redeemed || 0;
        if (coupon.max_redemptions) {
          redeemed += ' / ' + coupon.max_redemptions;
        }

        var expires = coupon.redeem_by ? formatDate(new Date(coupon.redeem_by * 1000)) : 'Never';

        html += '<tr>';
        html += '<td><strong>' + escapeHtml(coupon.name || coupon.id) + '</strong></td>';
        html += '<td><span class="feature-tag">' + discount + '</span></td>';
        html += '<td>' + duration + '</td>';
        html += '<td>' + redeemed + '</td>';
        html += '<td>' + expires + '</td>';
        html += '<td class="actions">';
        html += '<button class="btn btn-danger btn-sm action-btn" data-action="delete-coupon" data-id="' + escapeHtml(coupon.id) + '">Delete</button>';
        html += '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load coupons:', error);
      document.getElementById('couponsTable').innerHTML = '<tr><td colspan="6" style="text-align: center; color: #ef4444;">Failed to load coupons. Check Stripe configuration.</td></tr>';
    });
}

function loadPromoCodes() {
  api('/api/admin/promotion-codes')
    .then(function(response) {
      var promoCodes = response.data || [];
      var tbody = document.getElementById('promoCodesTable');

      if (promoCodes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b;">No promo codes yet. Create a coupon first, then add codes.</td></tr>';
        return;
      }

      var html = '';
      for (var i = 0; i < promoCodes.length; i++) {
        var promo = promoCodes[i];
        var redeemed = promo.times_redeemed || 0;
        var maxUses = promo.max_redemptions || 'Unlimited';
        var status = promo.active ? 'Active' : 'Inactive';
        var statusClass = promo.active ? 'status-active' : 'status-suspended';

        html += '<tr>';
        html += '<td><code style="font-weight: 600; background: #fef3c7; padding: 0.25rem 0.5rem; border-radius: 4px;">' + escapeHtml(promo.code) + '</code></td>';
        html += '<td>' + escapeHtml(promo.coupon.name || promo.coupon.id) + '</td>';
        html += '<td>' + redeemed + '</td>';
        html += '<td>' + maxUses + '</td>';
        html += '<td><span class="status-badge ' + statusClass + '">' + status + '</span></td>';
        html += '<td class="actions">';
        if (promo.active) {
          html += '<button class="btn btn-secondary btn-sm action-btn" data-action="deactivate-promo" data-id="' + escapeHtml(promo.id) + '">Deactivate</button>';
        } else {
          html += '<button class="btn btn-success btn-sm action-btn" data-action="activate-promo" data-id="' + escapeHtml(promo.id) + '">Activate</button>';
        }
        html += '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    })
    .catch(function(error) {
      console.error('Failed to load promo codes:', error);
      document.getElementById('promoCodesTable').innerHTML = '<tr><td colspan="6" style="text-align: center; color: #ef4444;">Failed to load promo codes.</td></tr>';
    });
}

// Coupon Modal
function openCouponModal() {
  document.getElementById('couponModal').classList.add('active');
  document.getElementById('couponForm').reset();
  document.getElementById('currencyGroup').style.display = 'none';
  document.getElementById('durationMonthsGroup').style.display = 'none';
  document.getElementById('discountHint').textContent = 'Percentage (1-100)';
}

function closeCouponModal() {
  document.getElementById('couponModal').classList.remove('active');
}

function handleCouponSubmit(e) {
  e.preventDefault();

  var discountType = document.getElementById('discountType').value;
  var discountValue = parseInt(document.getElementById('discountValue').value);

  var data = {
    name: document.getElementById('couponName').value,
    duration: document.getElementById('couponDuration').value
  };

  if (discountType === 'percent') {
    data.percentOff = discountValue;
  } else {
    data.amountOff = discountValue;
    data.currency = document.getElementById('couponCurrency').value;
  }

  if (data.duration === 'repeating') {
    data.durationInMonths = parseInt(document.getElementById('durationMonths').value);
  }

  var maxRedemptions = document.getElementById('couponMaxRedemptions').value;
  if (maxRedemptions) {
    data.maxRedemptions = parseInt(maxRedemptions);
  }

  var redeemBy = document.getElementById('couponRedeemBy').value;
  if (redeemBy) {
    data.redeemBy = new Date(redeemBy).toISOString();
  }

  api('/api/admin/coupons', { method: 'POST', body: JSON.stringify(data) })
    .then(function(coupon) {
      closeCouponModal();
      loadCoupons();
      alert('Coupon created: ' + (coupon.name || coupon.id));
    })
    .catch(function(error) {
      alert('Failed to create coupon: ' + error.message);
    });
}

function deleteCoupon(id) {
  if (!confirm('Delete this coupon? This will also invalidate any promo codes using it.')) return;

  api('/api/admin/coupons/' + id, { method: 'DELETE' })
    .then(function() {
      loadCoupons();
      loadPromoCodes();
    })
    .catch(function(error) {
      alert('Failed to delete coupon: ' + error.message);
    });
}

// Promo Code Modal
function openPromoCodeModal() {
  document.getElementById('promoCodeModal').classList.add('active');
  document.getElementById('promoCodeForm').reset();

  // Populate coupons dropdown
  var select = document.getElementById('promoCodeCoupon');
  select.innerHTML = '<option value="">Select a coupon...</option>';

  if (coupons.length === 0) {
    // Load coupons first
    api('/api/admin/coupons')
      .then(function(response) {
        coupons = response.data || [];
        populateCouponsDropdown();
      });
  } else {
    populateCouponsDropdown();
  }
}

function populateCouponsDropdown() {
  var select = document.getElementById('promoCodeCoupon');
  select.innerHTML = '<option value="">Select a coupon...</option>';
  for (var i = 0; i < coupons.length; i++) {
    var c = coupons[i];
    var label = c.name || c.id;
    var discount = c.percent_off ? c.percent_off + '% off' : formatCurrency(c.amount_off, c.currency) + ' off';
    select.innerHTML += '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(label) + ' (' + discount + ')</option>';
  }
}

function closePromoCodeModal() {
  document.getElementById('promoCodeModal').classList.remove('active');
}

function handlePromoCodeSubmit(e) {
  e.preventDefault();

  var data = {
    couponId: document.getElementById('promoCodeCoupon').value,
    code: document.getElementById('promoCode').value.toUpperCase()
  };

  var maxRedemptions = document.getElementById('promoMaxRedemptions').value;
  if (maxRedemptions) {
    data.maxRedemptions = parseInt(maxRedemptions);
  }

  var expiresAt = document.getElementById('promoExpiresAt').value;
  if (expiresAt) {
    data.expiresAt = new Date(expiresAt).toISOString();
  }

  if (document.getElementById('promoFirstTimeOnly').checked) {
    data.firstTimeTransaction = true;
  }

  var minAmount = document.getElementById('promoMinAmount').value;
  if (minAmount) {
    data.minimumAmount = parseInt(minAmount);
    data.minimumAmountCurrency = document.getElementById('promoMinCurrency').value;
  }

  api('/api/admin/promotion-codes', { method: 'POST', body: JSON.stringify(data) })
    .then(function(promo) {
      closePromoCodeModal();
      loadPromoCodes();
      alert('Promo code created: ' + promo.code);
    })
    .catch(function(error) {
      alert('Failed to create promo code: ' + error.message);
    });
}

function deactivatePromoCode(id) {
  if (!confirm('Deactivate this promo code? Customers will no longer be able to use it.')) return;

  api('/api/admin/promotion-codes/' + id, { method: 'PUT', body: JSON.stringify({ active: false }) })
    .then(function() {
      loadPromoCodes();
    })
    .catch(function(error) {
      alert('Failed to deactivate: ' + error.message);
    });
}

function activatePromoCode(id) {
  api('/api/admin/promotion-codes/' + id, { method: 'PUT', body: JSON.stringify({ active: true }) })
    .then(function() {
      loadPromoCodes();
    })
    .catch(function(error) {
      alert('Failed to activate: ' + error.message);
    });
}

function formatCurrency(amount, currency) {
  if (!amount) return '$0.00';
  var value = (amount / 100).toFixed(2);
  var symbols = { usd: '$', eur: '€', gbp: '£' };
  return (symbols[currency] || '$') + value;
}
