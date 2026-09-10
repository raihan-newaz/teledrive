/**
 * Setup Wizard Controller
 */
const Setup = {
  currentStep: 1,
  totalSteps: 5,
  data: {
    apiId: '',
    apiHash: '',
    botToken: '',
    channelId: '',
    masterPassword: '',
    encryptionKey: ''
  },

  init() {
    this.bindEvents();
    this.showStep(1);
  },

  bindEvents() {
    // Step navigation buttons
    const next1 = document.getElementById('btn-step-1-next');
    if (next1) next1.onclick = () => this.handleStep1Next();

    const prev2 = document.getElementById('btn-step-2-prev');
    const next2 = document.getElementById('btn-step-2-next');
    if (prev2) prev2.onclick = () => this.showStep(1);
    if (next2) next2.onclick = () => this.handleStep2Next();

    const prev3 = document.getElementById('btn-step-3-prev');
    const next3 = document.getElementById('btn-step-3-next');
    if (prev3) prev3.onclick = () => this.showStep(2);
    if (next3) next3.onclick = () => this.handleStep3Next();

    const prev4 = document.getElementById('btn-step-4-prev');
    const next4 = document.getElementById('btn-step-4-next');
    if (prev4) prev4.onclick = () => this.showStep(3);
    if (next4) next4.onclick = () => this.handleStep4Next();

    const prev5 = document.getElementById('btn-step-5-prev');
    const testBtn = document.getElementById('btn-test-connection');
    const completeBtn = document.getElementById('btn-complete-setup');
    if (prev5) prev5.onclick = () => this.showStep(4);
    if (testBtn) testBtn.onclick = () => this.testConnection();
    if (completeBtn) completeBtn.onclick = () => this.completeSetup();
  },

  showStep(step) {
    if (step < 1 || step > this.totalSteps) return;
    this.currentStep = step;

    // Hide all step containers
    for (let i = 1; i <= this.totalSteps; i++) {
      const el = document.getElementById(`wizard-step-${i}`);
      if (el) el.style.display = i === step ? 'block' : 'none';
    }

    // Update progress indicator
    document.querySelectorAll('.step-node').forEach(node => {
      const nodeStep = parseInt(node.getAttribute('data-step'), 10);
      if (nodeStep <= step) {
        node.classList.add('active');
      } else {
        node.classList.remove('active');
      }
    });
  },

  handleStep1Next() {
    const apiId = document.getElementById('setup-api-id').value.trim();
    const apiHash = document.getElementById('setup-api-hash').value.trim();

    if (!apiId || !apiHash) {
      UI.showToast('Please enter both API ID and API Hash from my.telegram.org', 'warning');
      return;
    }
    this.data.apiId = apiId;
    this.data.apiHash = apiHash;
    this.showStep(2);
  },

  handleStep2Next() {
    const botToken = document.getElementById('setup-bot-token').value.trim();
    if (!botToken || !botToken.includes(':')) {
      UI.showToast('Please enter a valid Bot Token from @BotFather', 'warning');
      return;
    }
    this.data.botToken = botToken;
    this.showStep(3);
  },

  handleStep3Next() {
    const channelId = document.getElementById('setup-channel-id').value.trim();
    if (!channelId) {
      UI.showToast('Please enter your private Telegram Channel ID', 'warning');
      return;
    }
    this.data.channelId = channelId;
    this.showStep(4);
  },

  handleStep4Next() {
    const pwd = document.getElementById('setup-password').value;
    const key = document.getElementById('setup-key').value;

    if (!pwd || pwd.length < 4) {
      UI.showToast('Master password must be at least 4 characters long', 'warning');
      return;
    }
    if (!key) {
      UI.showToast('Please provide an encryption passphrase', 'warning');
      return;
    }

    this.data.masterPassword = pwd;
    this.data.encryptionKey = key;
    this.showStep(5);
  },

  async testConnection() {
    const statusBox = document.getElementById('setup-test-status');
    if (statusBox) {
      statusBox.style.display = 'block';
      statusBox.className = 'test-status-box loading';
      statusBox.innerHTML = '<span class="status-spinner-sm" style="display:inline-block; width:14px; height:14px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; vertical-align:-2px; margin-right:6px;"></span> Connecting to Telegram MTProto... Please wait...';
    }

    try {
      const res = await API.validateTelegram(
        this.data.apiId,
        this.data.apiHash,
        this.data.botToken,
        this.data.channelId
      );

      if (res && res.valid) {
        if (statusBox) {
          statusBox.className = 'test-status-box success';
          statusBox.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: -2px; margin-right: 6px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><strong>Connection Successful!</strong> Bot can connect to Telegram and send encrypted files to your channel.';
        }
        UI.showToast('Telegram connection verified!', 'success');
      } else {
        throw new Error(res?.error || 'Validation failed');
      }
    } catch (e) {
      if (statusBox) {
        statusBox.className = 'test-status-box error';
        statusBox.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: -2px; margin-right: 6px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg><strong>Connection Failed:</strong> ${e.message || 'Check your credentials and ensure bot is channel Admin'}`;
      }
      UI.showToast('Connection failed: ' + (e.message || 'Error'), 'error');
    }
  },

  async completeSetup() {
    UI.showToast('Finalizing setup and configuring encryption...', 'info');

    try {
      const res = await API.completeSetup(this.data);
      if (res && res.success) {
        UI.showToast('TeleDrive setup complete! Launching drive...', 'success');
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      } else {
        throw new Error(res?.error || 'Could not complete setup');
      }
    } catch (e) {
      UI.showToast('Setup error: ' + (e.message || 'Error saving settings'), 'error');
    }
  }
};

// Initialize Setup wizard if DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Setup.init());
} else {
  Setup.init();
}
