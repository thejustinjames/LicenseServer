var API_URL = '';
// Token stored in memory (set from login response, also sent via httpOnly cookie)
var token = localStorage.getItem('token'); // Backward compat during migration
var user = JSON.parse(localStorage.getItem('user') || 'null');
var productSearchTimeout = null;

// CAPTCHA configuration
var captchaConfig = {
  enabled: false,
  siteKey: null,
  widgetIds: {}
};
var lastForgotEmail = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Load CAPTCHA configuration
  loadCaptchaConfig();

  // Bind all event listeners
  bindEvents();

  // Check authentication status from server (validates cookie)
  checkAuthStatus().then(function() {
    // Check for success redirect from Stripe
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('session_id')) {
      showSection('success');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // If not authenticated, show login modal
    if (!user) {
      openAuthModal('login');
    } else {
      loadCategories();
      // Don't load products until category is selected
    }
  });
});

// Load CAPTCHA configuration from server
function loadCaptchaConfig() {
  api('/api/portal/auth/captcha-config')
    .then(function(config) {
      captchaConfig.enabled = config.enabled;
      captchaConfig.siteKey = config.siteKey;
    })
    .catch(function(error) {
      console.warn('Failed to load CAPTCHA config:', error);
    });
}

// Render hCaptcha widget
function renderCaptcha(containerId) {
  if (!captchaConfig.enabled || !captchaConfig.siteKey) {
    return;
  }

  var container = document.getElementById(containerId);
  if (!container || container.children.length > 0) {
    return; // Already rendered or container missing
  }

  // Wait for hCaptcha to load
  if (typeof hcaptcha === 'undefined') {
    setTimeout(function() { renderCaptcha(containerId); }, 100);
    return;
  }

  try {
    var widgetId = hcaptcha.render(containerId, {
      sitekey: captchaConfig.siteKey,
      theme: 'light'
    });
    captchaConfig.widgetIds[containerId] = widgetId;
  } catch (e) {
    console.warn('Failed to render hCaptcha:', e);
  }
}

// Get CAPTCHA response token
function getCaptchaToken(containerId) {
  if (!captchaConfig.enabled) {
    return null;
  }

  var widgetId = captchaConfig.widgetIds[containerId];
  if (typeof hcaptcha !== 'undefined' && widgetId !== undefined) {
    return hcaptcha.getResponse(widgetId);
  }
  return null;
}

// Reset CAPTCHA widget
function resetCaptcha(containerId) {
  var widgetId = captchaConfig.widgetIds[containerId];
  if (typeof hcaptcha !== 'undefined' && widgetId !== undefined) {
    hcaptcha.reset(widgetId);
  }
}

// Check authentication status from server
function checkAuthStatus() {
  return api('/api/portal/me')
    .then(function(data) {
      user = data;
      localStorage.setItem('user', JSON.stringify(user));
      updateAuthUI();
    })
    .catch(function() {
      // Not authenticated or cookie expired
      user = null;
      token = null;
      localStorage.removeItem('user');
      localStorage.removeItem('token');
      updateAuthUI();
    });
}

// Bind all event listeners
function bindEvents() {
  // Navigation
  document.getElementById('logoLink').addEventListener('click', function(e) {
    e.preventDefault();
    showSection('home');
  });

  document.getElementById('productsLink').addEventListener('click', function(e) {
    e.preventDefault();
    showSection('home');
  });

  // Auth buttons - open modal
  document.getElementById('loginBtn').addEventListener('click', function() {
    openAuthModal('login');
  });

  document.getElementById('signupBtn').addEventListener('click', function() {
    openAuthModal('register');
  });

  document.getElementById('heroSignupBtn').addEventListener('click', function() {
    if (user) {
      // User is logged in - scroll to products and highlight dropdown
      var categorySelect = document.getElementById('categorySelect');
      categorySelect.scrollIntoView({ behavior: 'smooth', block: 'center' });
      categorySelect.focus();
      categorySelect.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.3)';
      setTimeout(function() {
        categorySelect.style.boxShadow = '';
      }, 2000);
    } else {
      openAuthModal('register');
    }
  });

  // Modal close button
  document.getElementById('closeAuthModal').addEventListener('click', function() {
    closeAuthModal();
  });

  // Close modal on backdrop click
  document.querySelector('.modal-backdrop').addEventListener('click', function() {
    closeAuthModal();
  });

  // Close modal on Escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeAuthModal();
    }
  });

  // Social login buttons (placeholder - show coming soon)
  document.getElementById('googleLoginBtn').addEventListener('click', handleSocialLogin);
  document.getElementById('facebookLoginBtn').addEventListener('click', handleSocialLogin);
  document.getElementById('googleSignupBtn').addEventListener('click', handleSocialLogin);
  document.getElementById('facebookSignupBtn').addEventListener('click', handleSocialLogin);

  // User nav
  document.getElementById('dashboardBtn').addEventListener('click', function() {
    showSection('dashboard');
  });

  document.getElementById('logoutBtn').addEventListener('click', function() {
    logout();
  });

  // Auth form switches within modal
  document.getElementById('switchToRegister').addEventListener('click', function(e) {
    e.preventDefault();
    showAuthView('register');
  });

  document.getElementById('switchToLogin').addEventListener('click', function(e) {
    e.preventDefault();
    showAuthView('login');
  });

  // Forgot password link
  document.getElementById('forgotPasswordLink').addEventListener('click', function(e) {
    e.preventDefault();
    showAuthView('forgotPassword');
  });

  // Back to login from forgot password
  document.getElementById('backToLogin').addEventListener('click', function(e) {
    e.preventDefault();
    showAuthView('login');
  });

  // Back to login from reset email sent
  document.getElementById('backToLoginFromReset').addEventListener('click', function(e) {
    e.preventDefault();
    showAuthView('login');
  });

  // Resend reset email
  document.getElementById('resendResetEmail').addEventListener('click', function() {
    if (lastForgotEmail) {
      handleForgotPasswordSubmit(lastForgotEmail);
    }
  });

  // Forms
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerForm').addEventListener('submit', handleRegister);
  document.getElementById('forgotPasswordForm').addEventListener('submit', handleForgotPassword);

  // Password toggle
  document.getElementById('togglePassword').addEventListener('click', function() {
    var passwordInput = document.getElementById('registerPassword');
    var eyeIcon = document.getElementById('eyeIcon');
    var eyeOffIcon = document.getElementById('eyeOffIcon');

    if (passwordInput.type === 'password') {
      passwordInput.type = 'text';
      eyeIcon.classList.add('hidden');
      eyeOffIcon.classList.remove('hidden');
    } else {
      passwordInput.type = 'password';
      eyeIcon.classList.remove('hidden');
      eyeOffIcon.classList.add('hidden');
    }
  });

  // Dashboard
  document.getElementById('billingPortalBtn').addEventListener('click', openBillingPortal);
  document.getElementById('successDashboardBtn').addEventListener('click', function() {
    showSection('dashboard');
  });

  // Product search and filter
  document.getElementById('productSearchInput').addEventListener('input', function() {
    clearTimeout(productSearchTimeout);
    productSearchTimeout = setTimeout(function() {
      loadProducts();
    }, 300);
  });
  document.getElementById('categorySelect').addEventListener('change', function() {
    var category = this.value;
    var searchInput = document.getElementById('productSearchInput');
    if (category) {
      searchInput.style.display = 'block';
      loadProducts();
    } else {
      searchInput.style.display = 'none';
      showProductPlaceholder();
    }
  });
}

// Section Navigation
function showSection(sectionId) {
  console.log('Showing section:', sectionId);
  var sections = document.querySelectorAll('.section');
  for (var i = 0; i < sections.length; i++) {
    sections[i].classList.remove('active');
  }
  document.getElementById(sectionId).classList.add('active');

  if (sectionId === 'dashboard' && user) {
    loadDashboard();
  }
}

// Auth Modal Functions
function openAuthModal(view) {
  var modal = document.getElementById('authModal');
  var closeBtn = document.getElementById('closeAuthModal');

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // Prevent background scrolling

  // Hide close button if login is required (not authenticated)
  if (!user) {
    closeBtn.classList.add('hidden');
  } else {
    closeBtn.classList.remove('hidden');
  }

  showAuthView(view || 'login');
}

function closeAuthModal() {
  // Don't allow closing if not authenticated
  if (!user) {
    return;
  }

  var modal = document.getElementById('authModal');
  modal.classList.add('hidden');
  document.body.style.overflow = ''; // Restore scrolling
  // Clear any error messages
  document.getElementById('loginAlert').innerHTML = '';
  document.getElementById('registerAlert').innerHTML = '';
  document.getElementById('forgotPasswordAlert').innerHTML = '';
}

function showAuthView(view) {
  var views = ['loginView', 'registerView', 'forgotPasswordView', 'resetEmailSentView'];

  // Hide all views
  views.forEach(function(viewId) {
    var el = document.getElementById(viewId);
    if (el) el.classList.add('hidden');
  });

  // Show the requested view
  var viewMap = {
    'login': 'loginView',
    'register': 'registerView',
    'forgotPassword': 'forgotPasswordView',
    'resetEmailSent': 'resetEmailSentView'
  };

  var targetView = document.getElementById(viewMap[view] || 'loginView');
  if (targetView) {
    targetView.classList.remove('hidden');
  }

  // Render CAPTCHA for views that need it
  if (view === 'login') {
    renderCaptcha('loginCaptcha');
  } else if (view === 'register') {
    renderCaptcha('registerCaptcha');
  } else if (view === 'forgotPassword') {
    renderCaptcha('forgotCaptcha');
  }
}

// Social Login Handler (placeholder)
function handleSocialLogin(e) {
  var provider = e.target.closest('.btn-google') ? 'Google' : 'Facebook';
  var alertEl = document.getElementById('loginView').classList.contains('hidden')
    ? document.getElementById('registerAlert')
    : document.getElementById('loginAlert');
  alertEl.innerHTML = '<div class="alert alert-info">' + provider + ' login coming soon!</div>';
}

// Auth UI
function updateAuthUI() {
  var authNav = document.getElementById('authNav');
  var userNav = document.getElementById('userNav');
  var userEmail = document.getElementById('userEmail');
  var adminLink = document.getElementById('adminLink');
  var heroBtn = document.getElementById('heroSignupBtn');

  if (user) {
    authNav.classList.add('hidden');
    userNav.classList.remove('hidden');
    userEmail.textContent = user.email;

    // Update hero button for logged in users
    if (heroBtn) {
      heroBtn.textContent = 'Select a Product';
    }

    // Show admin link for admin users
    if (user.isAdmin) {
      adminLink.classList.remove('hidden');
    } else {
      adminLink.classList.add('hidden');
    }
  } else {
    authNav.classList.remove('hidden');
    userNav.classList.add('hidden');
    adminLink.classList.add('hidden');

    // Reset hero button for logged out users
    if (heroBtn) {
      heroBtn.textContent = 'Get Started';
    }
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

// Load Categories
function loadCategories() {
  api('/api/portal/products/categories')
    .then(function(categories) {
      var select = document.getElementById('categorySelect');
      select.innerHTML = '<option value="">All Categories</option>';
      for (var i = 0; i < categories.length; i++) {
        select.innerHTML += '<option value="' + escapeHtml(categories[i]) + '">' + escapeHtml(categories[i]) + '</option>';
      }
    })
    .catch(function(error) {
      console.error('Failed to load categories:', error);
    });
}

// Show product placeholder (when no category selected)
function showProductPlaceholder() {
  var grid = document.getElementById('productsGrid');
  grid.innerHTML = '<div class="product-placeholder" style="text-align: center; padding: 3rem; color: #64748b;">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 1rem; opacity: 0.5;">' +
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>' +
    '<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>' +
    '<line x1="12" y1="22.08" x2="12" y2="12"></line>' +
    '</svg>' +
    '<p style="font-size: 1.1rem;">Select a product from the dropdown above to view available plans and pricing.</p>' +
    '</div>';
}

// Load Products
function loadProducts() {
  console.log('Loading products...');

  var search = document.getElementById('productSearchInput').value;
  var category = document.getElementById('categorySelect').value;

  // Don't load if no category selected
  if (!category) {
    showProductPlaceholder();
    return;
  }

  var url = '/api/portal/products';
  var params = [];
  if (search) params.push('search=' + encodeURIComponent(search));
  if (category) params.push('category=' + encodeURIComponent(category));
  if (params.length > 0) url += '?' + params.join('&');

  api(url)
    .then(function(products) {
      console.log('Products loaded:', products);
      var grid = document.getElementById('productsGrid');

      if (products.length === 0) {
        grid.innerHTML = '<p style="color: #64748b;">No products found.</p>';
        return;
      }

      var html = '';
      for (var i = 0; i < products.length; i++) {
        var product = products[i];
        html += '<div class="product-card">';
        if (product.category) {
          html += '<span class="product-category">' + escapeHtml(product.category) + '</span>';
        }
        html += '<h3>' + escapeHtml(product.name) + '</h3>';
        html += '<p>' + escapeHtml(product.description || 'No description') + '</p>';
        html += '<ul class="product-features">';
        var features = product.features || [];
        for (var j = 0; j < features.length; j++) {
          html += '<li>' + escapeHtml(features[j].replace(/-/g, ' ')) + '</li>';
        }
        html += '</ul>';

        // Display pricing based on product type
        if (product.priceMonthly !== null || product.priceAnnual !== null) {
          html += '<div class="product-pricing">';

          if (product.priceMonthly === 0) {
            // Free product
            html += '<div class="product-price">Free</div>';
            html += '<button class="btn btn-success checkout-btn" data-product-id="' + product.id + '" style="width: 100%;">Get Started</button>';
          } else if (product.purchaseType === 'ONE_TIME') {
            // One-time purchase
            var price = product.priceMonthly ? (product.priceMonthly / 100).toFixed(0) : (product.priceAnnual / 100).toFixed(0);
            html += '<div class="product-price">SGD ' + price + '</div>';
            if (product.hasStripePrice) {
              html += '<button class="btn btn-success checkout-btn" data-product-id="' + product.id + '" style="width: 100%;">Buy Now</button>';
            }
          } else if (product.priceMonthly && product.priceMonthly > 0) {
            // Subscription with monthly pricing
            html += '<div class="product-price">SGD ' + (product.priceMonthly / 100).toFixed(0) + '<span>/month</span></div>';
            if (product.priceAnnual && product.hasAnnualPrice) {
              var annualPrice = (product.priceAnnual / 100).toLocaleString();
              var monthlyEquiv = Math.round(product.priceAnnual / 100 / 12);
              var savings = Math.round((1 - (product.priceAnnual / (product.priceMonthly * 12))) * 100);
              html += '<div class="product-price-annual">or SGD ' + annualPrice + '/year <small>(save ' + savings + '%)</small></div>';
            }
            if (product.hasStripePrice) {
              html += '<div class="btn-group" style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">';
              html += '<button class="btn btn-success checkout-btn" data-product-id="' + product.id + '" data-billing="monthly" style="flex: 1;">Monthly</button>';
              if (product.hasAnnualPrice) {
                html += '<button class="btn btn-primary checkout-btn" data-product-id="' + product.id + '" data-billing="annual" style="flex: 1;">Yearly</button>';
              }
              html += '</div>';
            }
          } else if (product.priceAnnual) {
            // Annual-only subscription (Enterprise Packs)
            var annualPrice = (product.priceAnnual / 100).toLocaleString();
            html += '<div class="product-price">SGD ' + annualPrice + '<span>/year</span></div>';
            if (product.hasStripePrice || product.hasAnnualPrice) {
              html += '<button class="btn btn-success checkout-btn" data-product-id="' + product.id + '" data-billing="annual" style="width: 100%;">Subscribe Annually</button>';
            }
          }
          html += '</div>';
        } else {
          // POA - Contact sales
          html += '<div class="product-pricing">';
          html += '<div class="product-price" style="font-size: 1rem;">Contact Sales</div>';
          html += '<button class="btn btn-secondary" onclick="window.location.href=\'mailto:sales@agencio.cloud\'" style="width: 100%;">Request Quote</button>';
          html += '</div>';
        }
        html += '</div>';
      }
      grid.innerHTML = html;

      // Bind checkout buttons
      var checkoutBtns = document.querySelectorAll('.checkout-btn');
      for (var k = 0; k < checkoutBtns.length; k++) {
        checkoutBtns[k].addEventListener('click', function(e) {
          var productId = e.target.getAttribute('data-product-id');
          var billingInterval = e.target.getAttribute('data-billing') || 'monthly';
          checkout(productId, billingInterval);
        });
      }
    })
    .catch(function(error) {
      console.error('Failed to load products:', error);
      document.getElementById('productsGrid').innerHTML =
        '<p style="color: #ef4444;">Failed to load products. Is the server running?</p>';
    });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Copy to clipboard with feedback
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    // Show success feedback
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.style.color = '#22c55e';
    setTimeout(function() {
      btn.innerHTML = originalHtml;
      btn.style.color = '';
    }, 1500);
  }).catch(function(err) {
    console.error('Failed to copy:', err);
    alert('Failed to copy to clipboard');
  });
}

// Handle Login
function handleLogin(event) {
  event.preventDefault();
  var alertEl = document.getElementById('loginAlert');
  var email = document.getElementById('loginEmail').value;
  var password = document.getElementById('loginPassword').value;
  var captchaToken = getCaptchaToken('loginCaptcha');

  // Check CAPTCHA if enabled
  if (captchaConfig.enabled && !captchaToken) {
    alertEl.innerHTML = '<div class="alert alert-error">Please complete the CAPTCHA verification</div>';
    return;
  }

  var requestBody = { email: email, password: password };
  if (captchaToken) {
    requestBody.captchaToken = captchaToken;
  }

  fetch(API_URL + '/api/portal/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    credentials: 'include'
  })
  .then(function(response) {
    return response.json().then(function(data) {
      return { ok: response.ok, status: response.status, data: data };
    });
  })
  .then(function(result) {
    if (!result.ok) {
      // Check if account is locked
      if (result.data.locked) {
        var minutes = result.data.lockoutMinutesRemaining || 15;
        alertEl.innerHTML = '<div class="alert alert-error">' +
          '<strong>Account Locked</strong><br>' +
          'Too many failed login attempts. ' +
          'Please try again in ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '.' +
          '</div>';
      } else {
        alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(result.data.error || 'Login failed') + '</div>';
      }
      resetCaptcha('loginCaptcha');
      return;
    }

    var data = result.data;
    token = data.token;
    user = data.customer;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    updateAuthUI();

    // Close modal (now allowed since user is set)
    var modal = document.getElementById('authModal');
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    alertEl.innerHTML = '';

    // Load data now that user is authenticated
    loadCategories();
    showSection('home');
  })
  .catch(function(error) {
    alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(error.message) + '</div>';
    resetCaptcha('loginCaptcha');
  });
}

// Handle Register
function handleRegister(event) {
  event.preventDefault();
  var alertEl = document.getElementById('registerAlert');
  var name = document.getElementById('registerName').value;
  var email = document.getElementById('registerEmail').value;
  var password = document.getElementById('registerPassword').value;
  var captchaToken = getCaptchaToken('registerCaptcha');

  // Check CAPTCHA if enabled
  if (captchaConfig.enabled && !captchaToken) {
    alertEl.innerHTML = '<div class="alert alert-error">Please complete the CAPTCHA verification</div>';
    return;
  }

  var requestBody = { name: name, email: email, password: password };
  if (captchaToken) {
    requestBody.captchaToken = captchaToken;
  }

  api('/api/portal/auth/register', {
    method: 'POST',
    body: JSON.stringify(requestBody)
  })
  .then(function(data) {
    token = data.token;
    user = data.customer;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    updateAuthUI();

    // Close modal (now allowed since user is set)
    var modal = document.getElementById('authModal');
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    alertEl.innerHTML = '';

    // Load data now that user is authenticated
    loadCategories();
    showSection('home');
  })
  .catch(function(error) {
    alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(error.message) + '</div>';
    resetCaptcha('registerCaptcha');
  });
}

// Handle Forgot Password
function handleForgotPassword(event) {
  event.preventDefault();
  var email = document.getElementById('forgotEmail').value;
  handleForgotPasswordSubmit(email);
}

function handleForgotPasswordSubmit(email) {
  var alertEl = document.getElementById('forgotPasswordAlert');
  var captchaToken = getCaptchaToken('forgotCaptcha');

  // Check CAPTCHA if enabled
  if (captchaConfig.enabled && !captchaToken) {
    alertEl.innerHTML = '<div class="alert alert-error">Please complete the CAPTCHA verification</div>';
    return;
  }

  var requestBody = { email: email };
  if (captchaToken) {
    requestBody.captchaToken = captchaToken;
  }

  // Save email for resend
  lastForgotEmail = email;

  api('/api/portal/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify(requestBody)
  })
  .then(function(data) {
    showAuthView('resetEmailSent');
  })
  .catch(function(error) {
    alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(error.message) + '</div>';
    resetCaptcha('forgotCaptcha');
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
      user = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      updateAuthUI();
      showSection('home');
      // Show login modal since authentication is required
      openAuthModal('login');
    });
}

// Checkout
function checkout(productId, billingInterval) {
  console.log('Checkout for product:', productId, 'billing:', billingInterval);
  if (!user) {
    openAuthModal('login');
    return;
  }

  api('/api/portal/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ productId: productId, billingInterval: billingInterval || 'monthly' })
  })
  .then(function(data) {
    window.location.href = data.url;
  })
  .catch(function(error) {
    alert('Failed to start checkout: ' + error.message);
  });
}

// Load Dashboard
function loadDashboard() {
  Promise.all([
    api('/api/portal/licenses'),
    api('/api/portal/subscriptions')
  ])
  .then(function(results) {
    var licenses = results[0];
    var subscriptions = results[1];

    // Update stats
    var activeLicenses = licenses.filter(function(l) { return l.status === 'ACTIVE'; });
    var activeSubs = subscriptions.filter(function(s) { return s.status === 'ACTIVE'; });

    document.getElementById('activeLicenseCount').textContent = activeLicenses.length;
    document.getElementById('activeSubCount').textContent = activeSubs.length;

    // Update licenses table
    var licensesTable = document.getElementById('licensesTable');
    if (licenses.length === 0) {
      licensesTable.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b;">No licenses yet. Purchase a product to get started!</td></tr>';
    } else {
      var html = '';
      for (var i = 0; i < licenses.length; i++) {
        var license = licenses[i];
        html += '<tr>';
        html += '<td>' + escapeHtml(license.product.name) + '</td>';
        html += '<td><code class="license-key">' + escapeHtml(license.key) + '</code> <button class="btn-copy" data-key="' + escapeHtml(license.key) + '" title="Copy license key"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></td>';
        html += '<td><span class="status-badge status-' + license.status.toLowerCase() + '">' + license.status + '</span></td>';
        html += '<td>' + (license.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : 'Never') + '</td>';
        html += '<td>' + license.activations.length + ' / ' + license.maxActivations + '</td>';
        html += '<td>';
        if (license.status === 'ACTIVE' && license.product.s3PackageKey) {
          html += '<button class="btn btn-success btn-sm download-btn" data-product-id="' + license.product.id + '">Download</button>';
        } else if (license.status !== 'ACTIVE') {
          html += '<span style="color: #94a3b8;">-</span>';
        } else {
          html += '<span style="color: #94a3b8;">N/A</span>';
        }
        html += '</td>';
        html += '</tr>';
      }
      licensesTable.innerHTML = html;

      // Bind download buttons
      var downloadBtns = document.querySelectorAll('.download-btn');
      for (var k = 0; k < downloadBtns.length; k++) {
        downloadBtns[k].addEventListener('click', function(e) {
          var productId = e.target.getAttribute('data-product-id');
          getDownloadLink(productId);
        });
      }

      // Bind copy buttons
      var copyBtns = document.querySelectorAll('.btn-copy');
      for (var c = 0; c < copyBtns.length; c++) {
        copyBtns[c].addEventListener('click', function(e) {
          var btn = e.currentTarget;
          var key = btn.getAttribute('data-key');
          copyToClipboard(key, btn);
        });
      }
    }

    // Update subscriptions table
    var subscriptionsTable = document.getElementById('subscriptionsTable');
    if (subscriptions.length === 0) {
      subscriptionsTable.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #64748b;">No subscriptions yet.</td></tr>';
    } else {
      var subHtml = '';
      for (var j = 0; j < subscriptions.length; j++) {
        var sub = subscriptions[j];
        subHtml += '<tr>';
        subHtml += '<td><code style="font-size: 0.85rem;">' + escapeHtml(sub.stripeSubscriptionId) + '</code></td>';
        subHtml += '<td><span class="status-badge status-' + sub.status.toLowerCase() + '">' + sub.status + '</span></td>';
        subHtml += '<td>' + (sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : '-') + '</td>';
        subHtml += '<td>';
        if (sub.status === 'ACTIVE' && !sub.cancelAtPeriodEnd) {
          subHtml += '<button class="btn btn-secondary cancel-sub-btn" data-sub-id="' + sub.id + '">Cancel</button>';
        } else if (sub.cancelAtPeriodEnd) {
          subHtml += '<button class="btn btn-success reactivate-sub-btn" data-sub-id="' + sub.id + '">Reactivate</button>';
        } else {
          subHtml += '-';
        }
        subHtml += '</td>';
        subHtml += '</tr>';
      }
      subscriptionsTable.innerHTML = subHtml;

      // Bind subscription action buttons
      var cancelBtns = document.querySelectorAll('.cancel-sub-btn');
      for (var k = 0; k < cancelBtns.length; k++) {
        cancelBtns[k].addEventListener('click', function(e) {
          cancelSubscription(e.target.getAttribute('data-sub-id'));
        });
      }

      var reactivateBtns = document.querySelectorAll('.reactivate-sub-btn');
      for (var l = 0; l < reactivateBtns.length; l++) {
        reactivateBtns[l].addEventListener('click', function(e) {
          reactivateSubscription(e.target.getAttribute('data-sub-id'));
        });
      }
    }
  })
  .catch(function(error) {
    console.error('Failed to load dashboard:', error);
  });
}

// Get Download Link
function getDownloadLink(productId) {
  var alertEl = document.getElementById('dashboardAlert');
  alertEl.innerHTML = '<div class="alert alert-info">Generating download link...</div>';

  api('/api/portal/downloads/' + productId)
    .then(function(data) {
      // Show download info modal
      var expiryHours = data.expiresInHours || 4;
      var expiresAt = new Date(data.expiresAt).toLocaleString();

      alertEl.innerHTML = '<div class="download-info">' +
        '<div class="download-header">' +
          '<svg class="download-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
            '<polyline points="7 10 12 15 17 10"></polyline>' +
            '<line x1="12" y1="15" x2="12" y2="3"></line>' +
          '</svg>' +
          '<h4>Your Download is Ready!</h4>' +
        '</div>' +
        '<div class="download-warning">' +
          '<strong>Important:</strong> This download link expires in <strong>' + expiryHours + ' hours</strong>. ' +
          'Please download your software before ' + escapeHtml(expiresAt) + '.' +
        '</div>' +
        '<div class="download-details">' +
          '<p><strong>File:</strong> ' + escapeHtml(data.filename) + '</p>' +
        '</div>' +
        '<div class="download-actions">' +
          '<a href="' + data.url + '" class="btn btn-success btn-lg" download>' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 0.5rem;">' +
              '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
              '<polyline points="7 10 12 15 17 10"></polyline>' +
              '<line x1="12" y1="15" x2="12" y2="3"></line>' +
            '</svg>' +
            'Download Now' +
          '</a>' +
          '<button class="btn btn-secondary" onclick="document.getElementById(\'dashboardAlert\').innerHTML=\'\'">Close</button>' +
        '</div>' +
        '<p class="download-note">You can generate a new download link anytime from your dashboard.</p>' +
        '</div>';
    })
    .catch(function(error) {
      alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(error.message) + '</div>';
      setTimeout(function() {
        alertEl.innerHTML = '';
      }, 5000);
    });
}

// Billing Portal
function openBillingPortal() {
  var alertEl = document.getElementById('dashboardAlert');
  alertEl.innerHTML = '';

  api('/api/portal/billing/portal', { method: 'POST' })
    .then(function(data) {
      window.location.href = data.url;
    })
    .catch(function(error) {
      var message = error.message;
      if (message.includes('Stripe account')) {
        message = 'No billing account found. Complete a purchase to enable billing management.';
      }
      alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(message) + '</div>';
      setTimeout(function() {
        alertEl.innerHTML = '';
      }, 5000);
    });
}

// Cancel Subscription
function cancelSubscription(subscriptionId) {
  if (!confirm('Are you sure you want to cancel this subscription? It will remain active until the end of the billing period.')) {
    return;
  }

  api('/api/portal/subscriptions/' + subscriptionId + '/cancel', { method: 'POST' })
    .then(function() {
      loadDashboard();
    })
    .catch(function(error) {
      alert('Failed to cancel subscription: ' + error.message);
    });
}

// Reactivate Subscription
function reactivateSubscription(subscriptionId) {
  api('/api/portal/subscriptions/' + subscriptionId + '/reactivate', { method: 'POST' })
    .then(function() {
      loadDashboard();
    })
    .catch(function(error) {
      alert('Failed to reactivate subscription: ' + error.message);
    });
}
