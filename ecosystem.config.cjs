module.exports = {
  apps: [{
    name: "sara-stg",
    cwd: "/home/azureuser/sara",
    script: "npm",
    args: "run stg:start",
    env: {
      NODE_ENV: "production",
      APP_ENV: "stg",
      PORT: "3000",
      HOST: "0.0.0.0"
    },
    exec_mode: "cluster",
    instances: 1,
    watch: false,
    out_file: "/home/azureuser/pm2logs/sara-stg.out.log",
    error_file: "/home/azureuser/pm2logs/sara-stg.err.log",
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 2000
  }]
};
