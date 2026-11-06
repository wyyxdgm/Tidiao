module.exports = {
  apps: [
    {
      // 历史实例, 端口 15000 (dao.example.com:15000 = bt 预览版)。
      // 保留向后兼容, deploy.sh 不重启它。
      name: 'agent-orchestrator-bt',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      node_args: '--env-file=.env.local',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      // ao-prod (WSL 13000 / dao.example.com:13000)。
      // R153 phase 1a 启用 output: 'standalone' + distDir: 'dist' 后, standalone server.js
      // 找不到 client static chunks (build 产物不完整), HTML 引用 _next/static/chunks/*.css
      // 但磁盘不存在 → 404 → 浏览器无样式。详见 docs/deploy/2026-09-21.md。
      // 回退方案: 用 next start bin + 默认 .next/ 输出 (R155 那次的工作方式)。
      // ao-prod 此前一直用 next start bin 跑 (R153 没切换), 这次显式登记到 ecosystem
      // 是为了让 deploy.sh `pm2 restart ao-prod` 不再静默 no-op。
      name: 'ao-prod',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      node_args: '--env-file=.env.local',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: '13000',
        HOSTNAME: '0.0.0.0',
      },
    },
    {
      // ao-dev (WSL 13001 / dev.example.com:13001)。同 ao-prod 注释。
      name: 'ao-dev',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      node_args: '--env-file=.env.local',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: '13001',
        HOSTNAME: '0.0.0.0',
      },
    },
    {
      // ao-pulu (Pulu 13000 / ao.example.com:13000)。pulu 上历史只有 bt 条目,
      // ao-pulu 长期空缺 → deploy.sh restart/start 都 no-op, 13000 没人 listen。
      // 详见 docs/deploy/2026-09-18-pulu-restart.md。
      // 同 ao-prod: 用 next start bin, 回退到 .next/ 输出 (R153 standalone 已回退)。
      name: 'ao-pulu',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      node_args: '--env-file=.env.local',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: '13000',
        HOSTNAME: '0.0.0.0',
      },
    },
  ],
};