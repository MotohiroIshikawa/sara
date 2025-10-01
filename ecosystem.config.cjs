// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "sara-stg",
    cwd: "/home/azureuser/sara",
    script: "node",
    args: "server.mjs",
    node_args: "--require ./scripts/console-info-ensure-stdout.cjs",
    env: {
      NODE_ENV: "production",
      APP_ENV: "stg",
      PORT: "3000",
      HOST: "0.0.0.0"
    },
    exec_mode: "fork",
    instances: 1,
    watch: false,
    out_file: "/home/azureuser/pm2logs/sara-stg.out.log",
    error_file: "/home/azureuser/pm2logs/sara-stg.err.log",
    merge_logs: true
  }]
};
