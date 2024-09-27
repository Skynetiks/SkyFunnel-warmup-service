module.exports = {
  apps: [
    {
      name: 'SkyFunnel-Warmup-Service',
      script: './dist/src/index.js',
      watch: false,
      env_production: {
        NODE_ENV: 'production',
        PORT: 8080,
        // Add other environment variables here
      }
    }
  ]
};