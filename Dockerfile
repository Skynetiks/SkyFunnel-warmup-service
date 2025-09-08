# Stage 1: Use official Node.js image (alpine for smaller size)
FROM node:lts-alpine

# Set working directory inside the container
WORKDIR /app

# Copy only package files first for better caching
COPY package*.json ./

# Install only production dependencies
RUN npm i

# Copy the rest of the source code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the default HTTP port (override if needed)
EXPOSE 3000

# Default to running the API server — override for worker/queue
CMD ["npm", "run", "start"]
