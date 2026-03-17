var API_URL = '';
var token = localStorage.getItem('token');
var user = JSON.parse(localStorage.getItem('user') || 'null');

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  console.log('App initialized');

  // Bind all event listeners
  bindEvents();

  // Update UI
  updateAuthUI();
  loadProducts();

  // Check for success redirect from Stripe
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('session_id')) {
    showSection('success');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});

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

  if (token && user) {
    authNav.classList.add('hidden');
    userNav.classList.remove('hidden');
    userEmail.textContent = user.email;
  } else {
    authNav.classList.remove('hidden');
    userNav.classList.add('hidden');
  }
}

// API Helper
function api(endpoint, options) {
  options = options || {};
  var headers = {
    'Content-Type': 'application/json'
  };

  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  return fetch(API_URL + endpoint, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body
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

// Load Products
function loadProducts() {
  console.log('Loading products...');
  api('/api/portal/products')
    .then(function(products) {
      console.log('Products loaded:', products);
      var grid = document.getElementById('productsGrid');

      if (products.length === 0) {
        grid.innerHTML = '<p style="color: #64748b;">No products available yet.</p>';
        return;
      }

      var html = '';
      for (var i = 0; i < products.length; i++) {
        var product = products[i];
        html += '<div class="product-card">';
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
  token = null;
  user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  updateAuthUI();
  showSection('home');
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
      licensesTable.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No licenses yet. Purchase a product to get started!</td></tr>';
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
        html += '</tr>';
      }
      licensesTable.innerHTML = html;
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

// Billing Portal
function openBillingPortal() {
  api('/api/portal/billing/portal', { method: 'POST' })
    .then(function(data) {
      window.location.href = data.url;
    })
    .catch(function(error) {
      alert('Failed to open billing portal: ' + error.message);
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
