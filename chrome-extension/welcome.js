/**
 * AI History - Welcome/Onboarding Page Controller
 */

// DOM elements
let grantPermissionsBtn;
let statusEl;
let nextStepsEl;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeWelcomePage);

function initializeWelcomePage() {
  grantPermissionsBtn = document.getElementById('grantPermissions');
  statusEl = document.getElementById('status');
  nextStepsEl = document.getElementById('nextSteps');

  if (!grantPermissionsBtn) {
    console.error('[WELCOME] Required DOM elements not found');
    return;
  }

  // Set up event listeners
  grantPermissionsBtn.addEventListener('click', handleGrantPermissions);

  // Check if permissions are already granted
  checkExistingPermissions();
}

async function checkExistingPermissions() {
  try {
    // Check for host permissions
    const hasHttps = await chrome.permissions.contains({ origins: ['https://*/*'] });
    const hasHttp = await chrome.permissions.contains({ origins: ['http://*/*'] });

    if (hasHttps || hasHttp) {
      showSuccess('Permissions already granted! You\'re all set.');
      showNextSteps();
      updateButtonState('completed');
    }
  } catch (error) {
    console.error('[WELCOME] Failed to check existing permissions:', error);
  }
}

async function handleGrantPermissions() {
  try {
    updateButtonState('requesting');
    showStatus('Requesting permissions...', 'info');

    // Request comprehensive permissions
    const permissions = {
      origins: ['https://*/*', 'http://*/*'],
      permissions: ['activeTab', 'tabs', 'storage', 'scripting']
    };

    const granted = await chrome.permissions.request(permissions);

    if (granted) {
      showSuccess('✅ Permissions granted successfully! AI History is ready to use.');
      showNextSteps();
      updateButtonState('completed');

      // Notify background script that setup is complete
      try {
        await chrome.runtime.sendMessage({ type: 'onboarding-complete' });
      } catch (e) {
        console.warn('[WELCOME] Failed to notify background:', e);
      }

      // Auto-close after a delay
      setTimeout(() => {
        window.close();
      }, 5000);
    } else {
      showError('Permissions were not granted. AI History needs these permissions to function properly.');
      updateButtonState('retry');
    }
  } catch (error) {
    console.error('[WELCOME] Permission request failed:', error);
    showError('Failed to request permissions. Please try the manual setup option.');
    updateButtonState('retry');
  }
}

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
}

function showSuccess(message) {
  showStatus(message, 'success');
}

function showError(message) {
  showStatus(message, 'error');
}

function showNextSteps() {
  nextStepsEl.classList.add('show');
}

function updateButtonState(state) {
  switch (state) {
    case 'requesting':
      grantPermissionsBtn.disabled = true;
      grantPermissionsBtn.innerHTML = '⏳ Requesting Permissions...';
      break;

    case 'completed':
      grantPermissionsBtn.disabled = true;
      grantPermissionsBtn.innerHTML = '✅ Permissions Granted';
      grantPermissionsBtn.style.background = 'linear-gradient(135deg, #4ade80, #22c55e)';
      break;

    case 'retry':
      grantPermissionsBtn.disabled = false;
      grantPermissionsBtn.innerHTML = '🔄 Try Again';
      break;

    default:
      grantPermissionsBtn.disabled = false;
      grantPermissionsBtn.innerHTML = '✅ Grant Permissions & Continue';
  }
}

// Handle page unload
window.addEventListener('beforeunload', () => {
  // Clean up any ongoing operations
});

// Export for debugging
window.welcomePageController = {
  handleGrantPermissions,
  checkExistingPermissions
};