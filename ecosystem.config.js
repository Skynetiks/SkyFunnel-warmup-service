module.exports = {
    apps: [
      {
        name: 'SkyFunnel-Warmup-Service',
        script: './node_modules/.bin/ts-node',
        args: 'server.ts',
        watch: true,
        env_production: {
          NODE_ENV: 'production',
          PORT: 8080,
          // Add other environment variables here
        }
      }
    ]
  };
  