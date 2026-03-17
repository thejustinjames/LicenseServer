var API_URL = '';
// Token stored in memory (set from login response, also sent via httpOnly cookie)
var token = localStorage.getItem('token'); // Backward compat during migration
var user = JSON.parse(localStorage.getItem('user') || 'null');
var productSearchTimeout = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Bind all event listeners
  bindEvents();

  // Check authentication status from server (validates cookie)
  checkAuthStatus().then(function() {
    loadCategories();
    loadProducts();
  });

  // Check for success redirect from Stripe
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('session_id')) {
    showSection('success');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});

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

  // Auth buttons
  document.getElementById('loginBtn').addEventListener('click', function() {
    showSection('login');
  });

  document.getElementById('signupBtn').addEventListener('click', function() {
    showSection('register');
  });

  document.getElementById('heroSignupBtn').addEventListener('click', function() {
    showSection('register');
  });

  // User nav
  document.getElementById('dashboardBtn').addEventListener('click', function() {
    showSection('dashboard');
  });

  document.getElementById('logoutBtn').addEventListener('click', function() {
    logout();
  });

  // Auth form switches
  document.getElementById('switchToRegister').addEventListener('click', function() {
    showSection('register');
  });

  document.getElementById('switchToLogin').addEventListener('click', function() {
    showSection('login');
  });

  // Forms
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerForm').addEventListener('submit', handleRegister);

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
    loadProducts();
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

  if (sectionId === 'dashboard' && token) {
    loadDashboard();
  }
}

// Auth UI
function updateAuthUI() {
  var authNav = document.getElementById('authNav');
  var userNav = document.getElementById('userNav');
  var userEmail = document.getElementById('userEmail');
  var adminLink = document.getElementById('adminLink');

  if (token && user) {
    authNav.classList.add('hidden');
    userNav.classList.remove('hidden');
    userEmail.textContent = user.email;

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

// Load Products
function loadProducts() {
  console.log('Loading products...');

  var search = document.getElementById('productSearchInput').value;
  var category = document.getElementById('categorySelect').value;

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
        if (product.hasStripePrice) {
          html += '<div class="product-price">$9.99<span>/month</span></div>';
          html += '<button class="btn btn-success checkout-btn" data-product-id="' + product.id + '" style="width: 100%;">Subscribe Now</button>';
        } else {
          html += '<p style="color: #64748b; font-style: italic;">Pricing not configured</p>';
        }
        html += '</div>';
      }
      grid.innerHTML = html;

      // Bind checkout buttons
      var checkoutBtns = document.querySelectorAll('.checkout-btn');
      for (var k = 0; k < checkoutBtns.length; k++) {
        checkoutBtns[k].addEventListener('click', function(e) {
          var productId = e.target.getAttribute('data-product-id');
          checkout(productId);
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

// Handle Login
function handleLogin(event) {
  event.preventDefault();
  var alertEl = document.getElementById('loginAlert');
  var email = document.getElementById('loginEmail').value;
  var password = document.getElementById('loginPassword').value;

  api('/api/portal/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: email, password: password })
  })
  .then(function(data) {
    token = data.token;
    user = data.customer;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    updateAuthUI();
    showSection('dashboard');
  })
  .catch(function(error) {
    alertEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(error.message) + '</div>';
  });
}

// Handle Register
function handleRegister(event) {
  event.preventDefault();
  var alertEl = document.getElementById('registerAlert');
  var name = document.getElementById('registerName').value;
  var email = document.getElementById('registerEmail').value;
  var password = document.getElementById('registerPassword').value;

  api('/api/portal/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: name, email: email, password: password })
  })
  .then(function(data) {
    token = data.token;
    user = data.customer;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    updateAuthUI();
    showSection('dashboard');
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
      user = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      updateAuthUI();
      showSection('home');
    });
}

// Checkout
function checkout(productId) {
  console.log('Checkout for product:', productId);
  if (!token) {
    showSection('login');
    return;
  }

  api('/api/portal/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ productId: productId })
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
        html += '<td><code class="license-key">' + escapeHtml(license.key) + '</code></td>';
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
