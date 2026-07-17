cimport { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200)
  res.setHeader('Content-Type', 'text/html')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SMTP Mailbox Provisioning System - Developer Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #0b0f19;
      --bg-surface: #151d30;
      --bg-surface-hover: #1e2942;
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.15);
      --secondary: #a855f7;
      --accent: #06b6d4;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --border: #24324f;
      --border-focus: #4f46e5;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.5;
      overflow-x: hidden;
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.1) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(168, 85, 247, 0.1) 0px, transparent 50%);
    }

    header {
      border-bottom: 1px solid var(--border);
      background-color: rgba(21, 29, 48, 0.8);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 1rem 2rem;
    }

    .header-container {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .logo-icon {
      width: 2.25rem;
      height: 2.25rem;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      border-radius: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: white;
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.4);
    }

    .logo-text {
      font-size: 1.25rem;
      font-weight: 600;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #ffffff, #d1d5db);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-badge {
      font-size: 0.75rem;
      padding: 0.125rem 0.5rem;
      background-color: var(--primary-glow);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: var(--primary);
      border-radius: 9999px;
      font-weight: 500;
    }

    .auth-bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: rgba(11, 15, 25, 0.6);
      border: 1px solid var(--border);
      padding: 0.375rem 0.75rem;
      border-radius: 0.5rem;
    }

    .auth-label {
      font-size: 0.875rem;
      color: var(--text-muted);
    }

    .auth-input {
      background: transparent;
      border: none;
      color: var(--text-main);
      font-family: 'Fira Code', monospace;
      font-size: 0.875rem;
      outline: none;
      width: 250px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      display: inline-block;
      position: relative;
      box-shadow: 0 0 8px var(--success);
    }

    .status-dot.pulse::after {
      content: '';
      position: absolute;
      width: 100%;
      height: 100%;
      background-color: inherit;
      border-radius: inherit;
      animation: pulse-ring 1.5s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
      top: 0;
      left: 0;
    }

    @keyframes pulse-ring {
      0% { transform: scale(0.95); opacity: 0.8; }
      100% { transform: scale(2.5); opacity: 0; }
    }

    main {
      flex: 1;
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 2rem;
      display: grid;
      grid-template-columns: 1fr 450px;
      gap: 2rem;
    }

    @media (max-width: 1024px) {
      main {
        grid-template-columns: 1fr;
      }
    }

    .content-panel {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .console-panel {
      position: sticky;
      top: 5.5rem;
      height: calc(100vh - 7.5rem);
      min-height: 500px;
      display: flex;
      flex-direction: column;
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      overflow: hidden;
    }

    .console-header {
      background-color: rgba(11, 15, 25, 0.5);
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .console-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .console-clear {
      font-size: 0.75rem;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid var(--border);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .console-clear:hover {
      background-color: var(--bg-surface-hover);
      color: var(--text-main);
    }

    .console-logs {
      flex: 1;
      padding: 1rem;
      font-family: 'Fira Code', monospace;
      font-size: 0.8125rem;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      background-color: #080c14;
    }

    .log-item {
      border-left: 2px solid var(--primary);
      padding-left: 0.75rem;
      animation: fadeIn 0.2s ease-out;
    }

    .log-item.success { border-color: var(--success); }
    .log-item.error { border-color: var(--danger); }
    .log-item.warning { border-color: var(--warning); }

    .log-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.25rem;
      display: flex;
      justify-content: space-between;
    }

    .log-content {
      white-space: pre-wrap;
      word-break: break-all;
    }

    .nav-tabs {
      display: flex;
      gap: 0.25rem;
      background-color: var(--bg-surface);
      padding: 0.25rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      overflow-x: auto;
    }

    .tab-btn {
      flex: 1;
      padding: 0.625rem 1rem;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-weight: 500;
      font-size: 0.875rem;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .tab-btn:hover {
      color: var(--text-main);
      background-color: rgba(255, 255, 255, 0.03);
    }

    .tab-btn.active {
      color: white;
      background-color: var(--primary);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }

    .card {
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }

    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .card-description {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
      animation: fadeIn 0.3s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      margin-bottom: 1rem;
    }

    .form-group.full-width {
      grid-column: span 2;
    }

    label {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-main);
    }

    input[type="text"],
    input[type="number"],
    input[type="password"],
    textarea,
    select {
      background-color: var(--bg-base);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 0.625rem 0.875rem;
      border-radius: 0.5rem;
      font-family: inherit;
      font-size: 0.875rem;
      outline: none;
      transition: all 0.2s;
      width: 100%;
    }

    input:focus,
    textarea:focus,
    select:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px var(--primary-glow);
    }

    textarea {
      resize: vertical;
      min-height: 100px;
      font-family: 'Fira Code', monospace;
      font-size: 0.8125rem;
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      cursor: pointer;
    }

    .checkbox-group input {
      width: 1rem;
      height: 1rem;
      accent-color: var(--primary);
    }

    .checkbox-group label {
      cursor: pointer;
    }

    button.btn-primary {
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      border: none;
      color: white;
      padding: 0.75rem 1.5rem;
      font-weight: 600;
      font-size: 0.875rem;
      border-radius: 0.5rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
    }

    button.btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
    }

    button.btn-primary:active {
      transform: translateY(0);
    }

    button.btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 0.75rem 1.5rem;
      font-weight: 500;
      font-size: 0.875rem;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    button.btn-secondary:hover {
      background-color: var(--bg-surface-hover);
      border-color: var(--text-muted);
    }

    .btn-danger {
      background-color: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: var(--danger);
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-danger:hover {
      background-color: var(--danger);
      color: white;
    }

    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      margin-top: 1rem;
    }

    .vps-table-container {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      background-color: var(--bg-base);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
      text-align: left;
    }

    th {
      background-color: rgba(255, 255, 255, 0.02);
      color: var(--text-muted);
      font-weight: 500;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
    }

    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
    }

    tr:last-child td {
      border-bottom: none;
    }

    .badge {
      display: inline-block;
      padding: 0.125rem 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      border-radius: 0.25rem;
    }

    .badge-primary { background: var(--primary-glow); color: var(--primary); border: 1px solid rgba(99, 102, 241, 0.2); }
    .badge-success { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }

    .job-card {
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem;
      background-color: rgba(255, 255, 255, 0.01);
      margin-top: 1rem;
    }

    .job-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .job-id {
      font-family: 'Fira Code', monospace;
      font-size: 0.8125rem;
      color: var(--text-muted);
    }

    .progress-bar-bg {
      width: 100%;
      height: 8px;
      background-color: var(--bg-base);
      border-radius: 9999px;
      overflow: hidden;
      margin-bottom: 0.5rem;
      border: 1px solid var(--border);
    }

    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(to right, var(--primary), var(--accent));
      width: 0%;
      transition: width 0.5s ease-in-out;
    }

    .job-meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .logs-container {
      margin-top: 1rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      max-height: 200px;
      overflow-y: auto;
      background-color: var(--bg-base);
      padding: 0.75rem;
      font-family: 'Fira Code', monospace;
      font-size: 0.75rem;
    }

    .log-entry {
      margin-bottom: 0.25rem;
    }

    .env-badges {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
      flex-wrap: wrap;
    }

    .api-docs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }

    .api-doc-item {
      background-color: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.75rem;
      font-size: 0.75rem;
    }

    .api-doc-method {
      display: inline-block;
      font-weight: 700;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      margin-bottom: 0.5rem;
      font-family: 'Fira Code', monospace;
    }

    .method-get { background: rgba(16, 185, 129, 0.1); color: var(--success); }
    .method-post { background: rgba(99, 102, 241, 0.1); color: var(--primary); }
    .method-put { background: rgba(245, 158, 11, 0.1); color: var(--warning); }
    .method-delete { background: rgba(239, 68, 68, 0.1); color: var(--danger); }

    .api-doc-path {
      font-family: 'Fira Code', monospace;
      font-weight: 500;
      color: var(--text-main);
      display: block;
      margin-bottom: 0.25rem;
    }
  </style>
</head>
<body>

  <header>
    <div class="header-container">
      <div class="logo">
        <div class="logo-icon">M</div>
        <div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="logo-text">MailNerd Control Center</span>
            <span class="logo-badge">dev-server</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.375rem; margin-top: 0.125rem;">
            <span class="status-dot pulse"></span>
            <span>API Gateway active on port 3000</span>
          </div>
        </div>
      </div>

      <div class="auth-bar">
        <span class="auth-label">X-API-Key:</span>
        <input type="password" id="apiKeyInput" class="auth-input" placeholder="Enter API Secret" value="">
        <button id="toggleApiKey" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.875rem;">👁️</button>
      </div>
    </div>
  </header>

  <main>
    <div class="content-panel">
      
      <!-- Navigation Tabs -->
      <nav class="nav-tabs">
        <button class="tab-btn active" onclick="switchTab('dashboard')">📊 Overview</button>
        <button class="tab-btn" onclick="switchTab('config'); loadConfig();">⚙️ Configuration</button>
        <button class="tab-btn" onclick="switchTab('vps'); loadVPSList();">🖥️ VPS Nodes</button>
        <button class="tab-btn" onclick="switchTab('provision'); loadActiveJobs();">✉️ Provisioning</button>
      </nav>

      <!-- TAB: DASHBOARD / OVERVIEW -->
      <div id="tab-dashboard" class="tab-content active">
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title">🚀 Welcome to MailNerd Console</div>
          <div class="card-description">
            This developer console interfaces directly with your running Vercel local dev-server.
            Here, you can test operations, register VPS servers, and trigger/monitor automated Mailcow setups.
          </div>

          <div style="margin-top: 1.5rem;">
            <h4 style="font-size: 0.875rem; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">Quick System Status</h4>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 0.75rem;">
              <div style="background-color: var(--bg-base); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
                <div style="font-size: 0.75rem; color: var(--text-muted);">Dev Server URL</div>
                <div style="font-weight: 600; font-family: 'Fira Code', monospace; color: var(--primary); margin-top: 0.25rem;">http://localhost:3000</div>
              </div>
              <div style="background-color: var(--bg-base); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
                <div style="font-size: 0.75rem; color: var(--text-muted);">Inngest Dashboard</div>
                <a href="http://localhost:8288" target="_blank" style="font-weight: 600; font-family: 'Fira Code', monospace; color: var(--secondary); margin-top: 0.25rem; display: block; text-decoration: none;">http://localhost:8288 ↗</a>
              </div>
              <div style="background-color: var(--bg-base); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
                <div style="font-size: 0.75rem; color: var(--text-muted);">Health Check</div>
                <button onclick="checkHealth()" class="badge badge-success" style="cursor: pointer; margin-top: 0.35rem; display: inline-block;">Test /api/health</button>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">📖 API Reference Endpoint Map</div>
          <div class="card-description">Below are the HTTP endpoints exposed by the dev-server and matched by Vercel routing rules.</div>
          
          <div class="api-docs-grid">
            <div class="api-doc-item">
              <span class="api-doc-method method-get">GET</span>
              <span class="api-doc-path">/api/health</span>
              <span style="color: var(--text-muted);">Public health and timestamp check.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-get">GET</span>
              <span class="api-doc-path">/api/config</span>
              <span style="color: var(--text-muted);">Fetch current application credentials & limits.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-put">PUT</span>
              <span class="api-doc-path">/api/config</span>
              <span style="color: var(--text-muted);">Save updated Contabo/Cloudflare keys.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-post">POST</span>
              <span class="api-doc-path">/api/vps/register</span>
              <span style="color: var(--text-muted);">Register a VPS node with root SSH credentials.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-get">GET</span>
              <span class="api-doc-path">/api/vps</span>
              <span style="color: var(--text-muted);">List all registered, active VPS servers.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-delete">DELETE</span>
              <span class="api-doc-path">/api/vps/[vpsId]</span>
              <span style="color: var(--text-muted);">De-register and remove a VPS node from storage.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-post">POST</span>
              <span class="api-doc-path">/api/provision</span>
              <span style="color: var(--text-muted);">Create subdomains & install Mailcow Dockerized.</span>
            </div>
            <div class="api-doc-item">
              <span class="api-doc-method method-get">GET</span>
              <span class="api-doc-path">/api/provision/[jobId]</span>
              <span style="color: var(--text-muted);">Poll deployment state and job progress logs.</span>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB: CONFIGURATION -->
      <div id="tab-config" class="tab-content">
        <div class="card">
          <div class="card-title">⚙️ App Configuration Settings</div>
          <div class="card-description">Manage API keys and setup parameters. These are securely encrypted in Supabase.</div>
          
          <form id="configForm" onsubmit="saveConfig(event)">
            <h3 style="font-size: 0.95rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; color: var(--primary);">Cloudflare Settings</h3>
            <div class="form-grid">
              <div class="form-group">
                <label for="cloudflare_api_token">API Token (DNS Edit permission)</label>
                <input type="password" id="cloudflare_api_token" placeholder="Cloudflare API Token">
              </div>
              <div class="form-group">
                <label for="cloudflare_zone_id">Zone ID</label>
                <input type="text" id="cloudflare_zone_id" placeholder="Cloudflare Zone ID">
              </div>
            </div>

            <h3 style="font-size: 0.95rem; margin-top: 1rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; color: var(--secondary);">Contabo API Settings (Optional)</h3>
            <div class="form-grid">
              <div class="form-group">
                <label for="contabo_client_id">OAuth2 Client ID</label>
                <input type="text" id="contabo_client_id" placeholder="Client ID">
              </div>
              <div class="form-group">
                <label for="contabo_client_secret">OAuth2 Client Secret</label>
                <input type="password" id="contabo_client_secret" placeholder="Client Secret">
              </div>
              <div class="form-group">
                <label for="contabo_api_user">API User Email</label>
                <input type="text" id="contabo_api_user" placeholder="Contabo User Email">
              </div>
              <div class="form-group">
                <label for="contabo_api_password">API Password</label>
                <input type="password" id="contabo_api_password" placeholder="Contabo Password">
              </div>
              <div class="form-group">
                <label for="contabo_api_base">API Base URL</label>
                <input type="text" id="contabo_api_base" value="https://api.contabo.com">
              </div>
              <div class="form-group">
                <label for="contabo_auth_url">OAuth Token URL</label>
                <input type="text" id="contabo_auth_url" value="https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token">
              </div>
            </div>

            <h3 style="font-size: 0.95rem; margin-top: 1rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; color: var(--accent);">VPS Provisioning Limits</h3>
            <div class="form-grid">
              <div class="form-group">
                <label for="contabo_default_product_id">Default Product ID (e.g. VPS S)</label>
                <input type="text" id="contabo_default_product_id" value="vps-s-2tb-ssd">
              </div>
              <div class="form-group">
                <label for="contabo_default_region">Default Region</label>
                <input type="text" id="contabo_default_region" value="eur">
              </div>
              <div class="form-group">
                <label for="contabo_default_image">Default OS Image ID</label>
                <input type="text" id="contabo_default_image" value="ubuntu-22.04">
              </div>
              <div class="form-group">
                <label for="contabo_max_domains_per_node">Max Domains per VPS Node</label>
                <input type="number" id="contabo_max_domains_per_node" value="10" min="1">
              </div>
            </div>

            <div class="form-actions">
              <button type="button" class="btn-secondary" onclick="loadConfig()">Reset</button>
              <button type="submit" class="btn-primary">💾 Save Configuration</button>
            </div>
          </form>
        </div>
      </div>

      <!-- TAB: VPS NODES -->
      <div id="tab-vps" class="tab-content">
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title">🖥️ Registered VPS Nodes</div>
          <div class="card-description">Nodes currently available to host new domains. Manual nodes can be added below.</div>
          
          <div class="vps-table-container">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>IP Address</th>
                  <th>Location</th>
                  <th>Domains Hosted</th>
                  <th>Type</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="vpsTableBody">
                <tr>
                  <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Loading VPS servers...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">➕ Register a Manual VPS Server</div>
          <div class="card-description">Add any existing Ubuntu server accessible via SSH. Make sure Port 22 is open.</div>
          
          <form id="vpsForm" onsubmit="registerVPS(event)">
            <div class="form-grid">
              <div class="form-group">
                <label for="vps_ip">IP Address *</label>
                <input type="text" id="vps_ip" placeholder="192.0.2.1" required>
              </div>
              <div class="form-group">
                <label for="vps_label">Friendly Label *</label>
                <input type="text" id="vps_label" placeholder="RackNerd NY-1" required>
              </div>
              <div class="form-group">
                <label for="vps_username">SSH Username *</label>
                <input type="text" id="vps_username" value="root" required>
              </div>
              <div class="form-group">
                <label for="vps_location">Server Location *</label>
                <select id="vps_location" required>
                  <option value="US-East">US East (New York / Atlanta)</option>
                  <option value="US-West">US West (Los Angeles / Seattle)</option>
                  <option value="EUR">Europe (Frankfurt / London)</option>
                  <option value="ASIA">Asia Pacific (Singapore / Tokyo)</option>
                </select>
              </div>
              <div class="form-group full-width">
                <label for="vps_private_key">SSH Private Key (OpenSSH Format) *</label>
                <textarea id="vps_private_key" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\n..." required></textarea>
              </div>
            </div>

            <div class="checkbox-group">
              <input type="checkbox" id="vps_mailcow_installed" onchange="toggleMailcowFields()">
              <label for="vps_mailcow_installed">Mailcow is already installed on this server</label>
            </div>

            <div id="mailcowFields" class="form-grid" style="display: none; margin-bottom: 1rem;">
              <div class="form-group full-width">
                <label for="vps_mailcow_api_key">Mailcow API Key</label>
                <input type="text" id="vps_mailcow_api_key" placeholder="Get this from Mailcow UI -> Configuration -> API">
              </div>
            </div>

            <div class="form-actions">
              <button type="submit" class="btn-primary">🚀 Register VPS Node</button>
            </div>
          </form>
        </div>
      </div>

      <!-- TAB: PROVISIONING -->
      <div id="tab-provision" class="tab-content">
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title">✉️ Start a Mailbox Provisioning Job</div>
          <div class="card-description">
            This creates a set of random subdomains on your Cloudflare root domain, configures all standard DNS records (MX, SPF, DKIM, DMARC),
            and provisions inboxes on an available VPS node.
          </div>

          <form id="provisionForm" onsubmit="startProvision(event)">
            <div class="form-grid">
              <div class="form-group">
                <label for="prov_domain">Root Domain *</label>
                <input type="text" id="prov_domain" placeholder="example.com" required>
              </div>
              <div class="form-group">
                <label for="prov_min_sub">Min Subdomains</label>
                <input type="number" id="prov_min_sub" value="2" min="1" max="10">
              </div>
              <div class="form-group">
                <label for="prov_max_sub">Max Subdomains</label>
                <input type="number" id="prov_max_sub" value="4" min="1" max="10">
              </div>
              <div class="form-group">
                <label for="prov_min_inbox">Min Inboxes per Subdomain</label>
                <input type="number" id="prov_min_inbox" value="3" min="1" max="20">
              </div>
              <div class="form-group">
                <label for="prov_max_inbox">Max Inboxes per Subdomain</label>
                <input type="number" id="prov_max_inbox" value="6" min="1" max="20">
              </div>
            </div>

            <div class="form-actions">
              <button type="submit" class="btn-primary">⚙️ Start Provisioning Job</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-title">🔄 Active & Historical Provisioning Jobs</div>
          <div class="card-description">Jobs run asynchronously in the background via Inngest step functions.</div>
          
          <div id="activeJobsContainer">
            <div style="text-align: center; color: var(--text-muted); padding: 1rem;">No active or tracked jobs in this session yet.</div>
          </div>
        </div>
      </div>

    </div>

    <!-- Right Console Log Panel -->
    <div class="console-panel">
      <div class="console-header">
        <div class="console-title">
          <span style="font-size: 1.1rem;">💻</span>
          <span>HTTP REQUEST & EVENT LOG</span>
        </div>
        <button class="console-clear" onclick="clearConsole()">Clear</button>
      </div>
      <div class="console-logs" id="consoleLogs">
        <div class="log-item">
          <div class="log-meta">
            <span>System</span>
            <span>Just now</span>
          </div>
          <div class="log-content" style="color: var(--primary);">Developer Console successfully loaded. Enter your API secret above to start interacting with the API routes.</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    // Tab switching
    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      
      const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => btn.innerText.toLowerCase().includes(tabId));
      if (activeBtn) activeBtn.classList.add('active');
      
      const tabEl = document.getElementById('tab-' + tabId);
      if (tabEl) tabEl.classList.add('active');
    }

    // Toggle API Key visibility
    const apiKeyInput = document.getElementById('apiKeyInput');
    const toggleApiKeyBtn = document.getElementById('toggleApiKey');
    toggleApiKeyBtn.addEventListener('click', () => {
      if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleApiKeyBtn.innerText = '🙈';
      } else {
        apiKeyInput.type = 'password';
        toggleApiKeyBtn.innerText = '👁️';
      }
    });

    // Save key to localStorage on changes
    apiKeyInput.addEventListener('input', () => {
      localStorage.setItem('mailnerd_api_key', apiKeyInput.value);
    });
    
    // Load key from localStorage on load if exists
    if (localStorage.getItem('mailnerd_api_key')) {
      apiKeyInput.value = localStorage.getItem('mailnerd_api_key');
    }

    // Toggle Mailcow field visibility in registration form
    function toggleMailcowFields() {
      const isChecked = document.getElementById('vps_mailcow_installed').checked;
      document.getElementById('mailcowFields').style.display = isChecked ? 'grid' : 'none';
    }

    // Console logger helper
    function log(message, type = 'info') {
      const logs = document.getElementById('consoleLogs');
      const time = new Date().toLocaleTimeString();
      
      const item = document.createElement('div');
      item.className = 'log-item ' + type;
      
      let typeLabel = 'INFO';
      if (type === 'success') typeLabel = 'SUCCESS';
      if (type === 'error') typeLabel = 'ERROR';
      if (type === 'warning') typeLabel = 'WARN';

      item.innerHTML = \`
        <div class="log-meta">
          <span>[\${typeLabel}]</span>
          <span>\${time}</span>
        </div>
        <div class="log-content">\${typeof message === 'object' ? JSON.stringify(message, null, 2) : message}</div>
      \`;
      
      logs.appendChild(item);
      logs.scrollTop = logs.scrollHeight;
    }

    function clearConsole() {
      document.getElementById('consoleLogs').innerHTML = '';
      log('Console cleared.', 'info');
    }

    // API Header helper
    function getHeaders(extra = {}) {
      return {
        'Content-Type': 'application/json',
        'X-API-Key': apiKeyInput.value,
        ...extra
      };
    }

    // Endpoint 1: Health Check
    async function checkHealth() {
      log('GET /api/health - Requesting...');
      const start = Date.now();
      try {
        const res = await fetch('/api/health');
        const latency = Date.now() - start;
        const data = await res.json();
        
        if (res.ok) {
          log(\`GET /api/health - Success (\${latency}ms): \` + JSON.stringify(data), 'success');
        } else {
          log(\`GET /api/health - Failed (\${latency}ms): [\${res.status}] \` + JSON.stringify(data), 'error');
        }
      } catch (err) {
        log('GET /api/health - Network Error: ' + err.message, 'error');
      }
    }

    // Endpoint 2: Load Config
    async function loadConfig() {
      log('GET /api/config - Fetching app config...');
      try {
        const res = await fetch('/api/config', {
          headers: getHeaders()
        });
        const data = await res.json();
        
        if (res.ok) {
          log('GET /api/config - Config fetched successfully.', 'success');
          
          // Populate fields
          document.getElementById('cloudflare_api_token').value = data.cloudflare_api_token || '';
          document.getElementById('cloudflare_zone_id').value = data.cloudflare_zone_id || '';
          document.getElementById('contabo_client_id').value = data.contabo_client_id || '';
          document.getElementById('contabo_client_secret').value = data.contabo_client_secret || '';
          document.getElementById('contabo_api_user').value = data.contabo_api_user || '';
          document.getElementById('contabo_api_password').value = data.contabo_api_password || '';
          if (data.contabo_api_base) document.getElementById('contabo_api_base').value = data.contabo_api_base;
          if (data.contabo_auth_url) document.getElementById('contabo_auth_url').value = data.contabo_auth_url;
          if (data.contabo_default_product_id) document.getElementById('contabo_default_product_id').value = data.contabo_default_product_id;
          if (data.contabo_default_region) document.getElementById('contabo_default_region').value = data.contabo_default_region;
          if (data.contabo_default_image) document.getElementById('contabo_default_image').value = data.contabo_default_image;
          if (data.contabo_max_domains_per_node !== undefined) document.getElementById('contabo_max_domains_per_node').value = data.contabo_max_domains_per_node;
        } else {
          log('GET /api/config - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
        }
      } catch (err) {
        log('GET /api/config - Network Error: ' + err.message, 'error');
      }
    }

    // Endpoint 3: Save Config
    async function saveConfig(event) {
      event.preventDefault();
      log('PUT /api/config - Saving updated configs...');
      
      const payload = {
        cloudflare_api_token: document.getElementById('cloudflare_api_token').value,
        cloudflare_zone_id: document.getElementById('cloudflare_zone_id').value,
        contabo_client_id: document.getElementById('contabo_client_id').value,
        contabo_client_secret: document.getElementById('contabo_client_secret').value,
        contabo_api_user: document.getElementById('contabo_api_user').value,
        contabo_api_password: document.getElementById('contabo_api_password').value,
        contabo_api_base: document.getElementById('contabo_api_base').value,
        contabo_auth_url: document.getElementById('contabo_auth_url').value,
        contabo_default_product_id: document.getElementById('contabo_default_product_id').value,
        contabo_default_region: document.getElementById('contabo_default_region').value,
        contabo_default_image: document.getElementById('contabo_default_image').value,
        contabo_max_domains_per_node: parseInt(document.getElementById('contabo_max_domains_per_node').value, 10)
      };

      try {
        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: getHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (res.ok) {
          log('PUT /api/config - Config saved successfully!', 'success');
          alert('Configuration saved successfully!');
        } else {
          log('PUT /api/config - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
        }
      } catch (err) {
        log('PUT /api/config - Network Error: ' + err.message, 'error');
      }
    }

    // Endpoint 4: List VPS
    async function loadVPSList() {
      log('GET /api/vps - Fetching registered VPS servers...');
      const tbody = document.getElementById('vpsTableBody');
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading nodes...</td></tr>';
      
      try {
        const res = await fetch('/api/vps', {
          headers: getHeaders()
        });
        const data = await res.json();
        
        if (res.ok) {
          log('GET /api/vps - Fetched ' + (Array.isArray(data) ? data.length : 0) + ' servers.', 'success');
          
          if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">No VPS nodes registered yet.</td></tr>';
            return;
          }

          tbody.innerHTML = data.map(vps => {
            const badgeType = vps.is_auto_provisioned ? 'badge-primary' : 'badge-success';
            const labelType = vps.is_auto_provisioned ? 'Contabo (Auto)' : 'Manual';
            
            return \`
              <tr>
                <td style="font-weight: 500;">\${vps.label || 'Unnamed VPS'}</td>
                <td style="font-family: 'Fira Code', monospace;">\${vps.ip}</td>
                <td>\${vps.location || 'Unknown'}</td>
                <td style="font-weight: 600;">\${vps.current_domain_count || 0} / \${vps.max_domains || 10}</td>
                <td><span class="badge \${badgeType}">\${labelType}</span></td>
                <td>
                  <button class="btn-danger" onclick="deleteVPS('\${vps.id}')">Delete</button>
                </td>
              </tr>
            \`;
          }).join('');
        } else {
          log('GET /api/vps - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 1.5rem;">Failed to load VPS nodes. Check logs.</td></tr>';
        }
      } catch (err) {
        log('GET /api/vps - Network Error: ' + err.message, 'error');
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 1.5rem;">Network Error: ' + err.message + '</td></tr>';
      }
    }

    // Endpoint 5: Delete VPS
    async function deleteVPS(vpsId) {
      if (!confirm('Are you sure you want to remove this VPS node? This does not delete the physical server, but removes it from the provisioning database.')) {
        return;
      }
      
      log('DELETE /api/vps/' + vpsId + ' - Removing node...');
      try {
        const res = await fetch('/api/vps/' + vpsId, {
          method: 'DELETE',
          headers: getHeaders()
        });
        const data = await res.json();
        
        if (res.ok) {
          log('DELETE /api/vps/' + vpsId + ' - Node removed successfully!', 'success');
          loadVPSList();
        } else {
          log('DELETE /api/vps/' + vpsId + ' - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
        }
      } catch (err) {
        log('DELETE /api/vps/' + vpsId + ' - Network Error: ' + err.message, 'error');
      }
    }

    // Endpoint 6: Register Manual VPS
    async function registerVPS(event) {
      event.preventDefault();
      log('POST /api/vps/register - Submitting registration...');
      
      const payload = {
        ip: document.getElementById('vps_ip').value,
        label: document.getElementById('vps_label').value,
        sshUsername: document.getElementById('vps_username').value,
        sshPrivateKey: document.getElementById('vps_private_key').value,
        location: document.getElementById('vps_location').value,
        mailcowAlreadyInstalled: document.getElementById('vps_mailcow_installed').checked,
        mailcowApiKey: document.getElementById('vps_mailcow_installed').checked ? document.getElementById('vps_mailcow_api_key').value : undefined
      };

      try {
        const res = await fetch('/api/vps/register', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (res.ok) {
          log('POST /api/vps/register - Success: ' + JSON.stringify(data), 'success');
          alert('VPS node registered successfully!');
          document.getElementById('vpsForm').reset();
          toggleMailcowFields();
          loadVPSList();
        } else {
          log('POST /api/vps/register - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
          alert('VPS registration failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        log('POST /api/vps/register - Network Error: ' + err.message, 'error');
      }
    }

    // Tracking active jobs in memory
    const trackedJobs = new Set();
    const jobPollIntervals = {};

    // Load active jobs from localStorage if they exist
    function loadActiveJobs() {
      const saved = localStorage.getItem('mailnerd_tracked_jobs');
      if (saved) {
        const list = JSON.parse(saved);
        list.forEach(id => {
          if (!trackedJobs.has(id)) {
            trackedJobs.add(id);
            createJobUI(id);
            pollJobStatus(id);
          }
        });
      }
    }

    function saveTrackedJobs() {
      localStorage.setItem('mailnerd_tracked_jobs', JSON.stringify(Array.from(trackedJobs)));
    }

    // Endpoint 7: Start Provisioning Job
    async function startProvision(event) {
      event.preventDefault();
      log('POST /api/provision - Starting provisioning job...');
      
      const payload = {
        rootDomain: document.getElementById('prov_domain').value,
        minSubdomains: parseInt(document.getElementById('prov_min_sub').value, 10),
        maxSubdomains: parseInt(document.getElementById('prov_max_sub').value, 10),
        minInboxes: parseInt(document.getElementById('prov_min_inbox').value, 10),
        maxInboxes: parseInt(document.getElementById('prov_max_inbox').value, 10)
      };

      try {
        const res = await fetch('/api/provision', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (res.ok) {
          log('POST /api/provision - Job created successfully! ID: ' + data.jobId, 'success');
          
          const jobId = data.jobId;
          trackedJobs.add(jobId);
          saveTrackedJobs();
          
          createJobUI(jobId);
          pollJobStatus(jobId);
        } else {
          log('POST /api/provision - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
          alert('Provisioning failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        log('POST /api/provision - Network Error: ' + err.message, 'error');
      }
    }

    function createJobUI(jobId) {
      // Clear empty message if any
      const container = document.getElementById('activeJobsContainer');
      if (container.innerText.includes('No active or tracked jobs')) {
        container.innerHTML = '';
      }

      // Check if already created
      if (document.getElementById('job-card-' + jobId)) return;

      const jobCard = document.createElement('div');
      jobCard.className = 'job-card';
      jobCard.id = 'job-card-' + jobId;
      jobCard.innerHTML = \`
        <div class="job-header">
          <div>
            <div style="font-weight: 600; display: flex; align-items: center; gap: 0.5rem;">
              <span>Job Status:</span>
              <span id="job-badge-\${jobId}" class="badge badge-primary">pending</span>
            </div>
            <div class="job-id">\${jobId}</div>
          </div>
          <button class="btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="removeJobFromUI('\${jobId}')">Dismiss</button>
        </div>
        
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="job-progress-\${jobId}"></div>
        </div>

        <div class="job-meta-row" style="margin-bottom: 0.5rem;">
          <span id="job-domains-\${jobId}">Subdomains: Planning...</span>
          <span id="job-time-\${jobId}">Est: -- mins</span>
        </div>

        <div class="logs-container" id="job-logs-\${jobId}">
          <div class="log-entry" style="color: var(--text-muted);">[System] Local polling initialized...</div>
        </div>
      \`;
      container.insertBefore(jobCard, container.firstChild);
    }

    function removeJobFromUI(jobId) {
      // Clear interval
      if (jobPollIntervals[jobId]) {
        clearInterval(jobPollIntervals[jobId]);
        delete jobPollIntervals[jobId];
      }
      
      // Remove from UI
      const card = document.getElementById('job-card-' + jobId);
      if (card) card.remove();
      
      // Remove from tracker
      trackedJobs.delete(jobId);
      saveTrackedJobs();

      // Show default message if empty
      const container = document.getElementById('activeJobsContainer');
      if (container.children.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1rem;">No active or tracked jobs in this session yet.</div>';
      }
    }

    // Endpoint 8: Poll Job Status
    async function pollJobStatus(jobId) {
      if (jobPollIntervals[jobId]) return;

      const runPoll = async () => {
        try {
          const res = await fetch('/api/provision/' + jobId, {
            headers: getHeaders()
          });
          const data = await res.json();
          
          if (!res.ok) {
            log('GET /api/provision/' + jobId + ' - Failed: [' + res.status + '] ' + JSON.stringify(data), 'error');
            return;
          }

          // Update UI
          const badge = document.getElementById('job-badge-' + jobId);
          const progress = document.getElementById('job-progress-' + jobId);
          const domainsText = document.getElementById('job-domains-' + jobId);
          const timeText = document.getElementById('job-time-' + jobId);
          const logsBox = document.getElementById('job-logs-' + jobId);

          if (!badge) return;

          badge.innerText = data.status || 'unknown';
          
          // Map status to badges
          badge.className = 'badge';
          if (data.status === 'completed') {
            badge.classList.add('badge-success');
            progress.style.width = '100%';
            // Stop polling
            clearInterval(jobPollIntervals[jobId]);
            delete jobPollIntervals[jobId];
          } else if (data.status === 'failed') {
            badge.classList.add('badge-danger');
            badge.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
            badge.style.color = 'var(--danger)';
            progress.style.width = '100%';
            progress.style.background = 'var(--danger)';
            // Stop polling
            clearInterval(jobPollIntervals[jobId]);
            delete jobPollIntervals[jobId];
          } else {
            badge.classList.add('badge-primary');
            // Estimate progress
            if (data.status === 'planning') progress.style.width = '15%';
            else if (data.status === 'provisioning_vps') progress.style.width = '40%';
            else if (data.status === 'configuring_dns') progress.style.width = '65%';
            else if (data.status === 'deploying_mailcow') progress.style.width = '85%';
            else progress.style.width = '10%';
          }

          if (data.totalSubdomains) {
            domainsText.innerText = \`Subdomains: \${data.totalSubdomains} (\${data.totalMailboxes || 0} inboxes)\`;
          }
          if (data.estimatedMinutes) {
            timeText.innerText = \`Est: \${data.estimatedMinutes} mins\`;
          }

          // Render step logs
          if (Array.isArray(data.steps) && data.steps.length > 0) {
            logsBox.innerHTML = data.steps.map(step => {
              const stepTime = step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : '';
              let statusSymbol = '⏳';
              let stepColor = 'var(--text-muted)';
              if (step.status === 'completed') { statusSymbol = '✅'; stepColor = 'var(--success)'; }
              if (step.status === 'failed') { statusSymbol = '❌'; stepColor = 'var(--danger)'; }
              
              return \`<div class="log-entry" style="color: \${stepColor}">
                [\${stepTime}] \${statusSymbol} <strong>\${step.name}</strong> - \${step.message || step.status}
              </div>\`;
            }).join('');
          } else if (data.error) {
            logsBox.innerHTML = \`<div class="log-entry" style="color: var(--danger)">[Error] \${data.error}</div>\`;
          } else {
            logsBox.innerHTML = \`<div class="log-entry" style="color: var(--text-muted)">[\${new Date().toLocaleTimeString()}] Waiting for execution steps...</div>\`;
          }

        } catch (err) {
          console.error('Error polling job:', err);
        }
      };

      // Run immediately first
      await runPoll();
      
      // Setup interval
      jobPollIntervals[jobId] = setInterval(runPoll, 3000);
    }

    // Initialize UI
    window.addEventListener('DOMContentLoaded', () => {
      // Auto test health
      checkHealth();
    });
  </script>
</body>
</html>
`)
}
