/**
 * Amoiq Chat Widget Loader
 * Version: 1.0.0
 * 
 * This script injects the chat widget iframe into the page.
 * It reads window.ChatWidgetConfig for configuration.
 */

(function() {
  'use strict';

  // Wait for config to be available
  function initWidget() {
    const config = window.ChatWidgetConfig || {};
    const tenantId = config.tenantId;
    const position = config.position || 'bottom-right';
    
    // tenantId is optional - Gateway will resolve it from domain if not provided

    // Prevent multiple initializations
    if (document.getElementById('amoiq-widget-container')) {
      return;
    }

    // Create container
    const container = document.createElement('div');
    container.id = 'amoiq-widget-container';
    container.style.cssText = `
      position: fixed;
      z-index: 999999;
      ${getPositionStyles(position)};
    `;
    document.body.appendChild(container);

    // Create bubble button with Amo IQ logo style
    const bubble = document.createElement('div');
    bubble.id = 'amoiq-widget-bubble';
    bubble.style.cssText = `
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%);
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(59, 130, 246, 0.4), 0 0 0 0 rgba(59, 130, 246, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      position: relative;
    `;
    
    // Create the four-pointed star/spark icon matching the Amo IQ logo
    bubble.innerHTML = `
      <svg id="amoiq-widget-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="transition: transform 0.3s ease; filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.5));">
        <!-- Four-pointed star/spark icon -->
        <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="white" stroke="white" stroke-width="0.5"/>
        <!-- Additional spark lines for depth -->
        <path d="M12 2L12 6M12 14L12 18M2 10L6 10M18 10L22 10" stroke="white" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
      </svg>
    `;
    
    // Add hover effects with glow animation
    bubble.addEventListener('mouseenter', function() {
      this.style.transform = 'scale(1.1)';
      this.style.boxShadow = '0 6px 30px rgba(59, 130, 246, 0.6), 0 0 0 4px rgba(59, 130, 246, 0.2)';
      const icon = this.querySelector('#amoiq-widget-icon');
      if (icon) {
        icon.style.transform = 'rotate(15deg) scale(1.1)';
      }
    });
    
    bubble.addEventListener('mouseleave', function() {
      this.style.transform = 'scale(1)';
      this.style.boxShadow = '0 4px 20px rgba(59, 130, 246, 0.4), 0 0 0 0 rgba(59, 130, 246, 0.3)';
      const icon = this.querySelector('#amoiq-widget-icon');
      if (icon) {
        icon.style.transform = 'rotate(0deg) scale(1)';
      }
    });
    
    // Add pulsing glow effect
    let glowInterval = setInterval(function() {
      if (bubble.style.boxShadow.includes('0.4')) {
        bubble.style.boxShadow = '0 4px 20px rgba(59, 130, 246, 0.5), 0 0 0 0 rgba(59, 130, 246, 0.3)';
      } else {
        bubble.style.boxShadow = '0 4px 20px rgba(59, 130, 246, 0.4), 0 0 0 0 rgba(59, 130, 246, 0.3)';
      }
    }, 2000);
    
    container.appendChild(bubble);

    // Create iframe (hidden initially)
    const iframe = document.createElement('iframe');
    iframe.id = 'amoiq-widget-iframe';
    const baseUrl = config.baseUrl || getBaseUrl();
    
    // Build URL with tenantId (if provided) and website info
    const urlParams = new URLSearchParams();
    // Only add tenantId if provided - Gateway will resolve from domain if not provided
    if (tenantId) {
      urlParams.set('tenantId', tenantId);
    }
    
    // Add website info from current page
    if (typeof window !== 'undefined') {
      urlParams.set('domain', window.location.hostname);
      urlParams.set('origin', window.location.origin);
      urlParams.set('url', window.location.href);
      if (document.referrer) {
        urlParams.set('referrer', document.referrer);
      }
    }
    
    // Add optional siteId from config if provided
    if (config.siteId) {
      urlParams.set('siteId', config.siteId);
    }
    
    iframe.src = `${baseUrl}/embed?${urlParams.toString()}`;
    iframe.style.cssText = `
      width: 380px;
      height: 600px;
      border: none;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      display: none;
      background: white;
    `;
    container.appendChild(iframe);

    let isOpen = false;

    // Toggle chat
    function toggleChat() {
      isOpen = !isOpen;
      if (isOpen) {
        iframe.style.display = 'block';
        bubble.style.display = 'none';
        iframe.focus();
        // Notify iframe that chat is now open (for WebSocket initialization)
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'amoiq-widget-open' }, '*');
        }
      } else {
        iframe.style.display = 'none';
        bubble.style.display = 'flex';
      }
    }

    bubble.addEventListener('click', toggleChat);

    // Close on outside click (optional)
    document.addEventListener('click', function(e) {
      if (isOpen && !container.contains(e.target)) {
        toggleChat();
      }
    });

    // Listen for messages from iframe to close
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'amoiq-widget-close') {
        if (isOpen) {
          toggleChat();
        }
      }
    });
  }

  function getPositionStyles(position) {
    const positions = {
      'bottom-right': 'bottom: 20px; right: 20px;',
      'bottom-left': 'bottom: 20px; left: 20px;',
      'top-right': 'top: 20px; right: 20px;',
      'top-left': 'top: 20px; left: 20px;',
    };
    return positions[position] || positions['bottom-right'];
  }

  function getBaseUrl() {
    // In production, this should be https://webchat.amoiq.com
    // For development, detect current origin
    if (typeof window !== 'undefined') {
      const script = document.currentScript || 
        Array.from(document.getElementsByTagName('script')).pop();
      if (script && script.src) {
        const url = new URL(script.src);
        return url.origin;
      }
    }
    return window.location.origin;
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }

  // Also try after a short delay in case config is set asynchronously
  setTimeout(initWidget, 100);
})();

