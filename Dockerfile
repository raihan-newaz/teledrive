# Use official Node.js LTS Alpine image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies needed for node native builds, timezone data, and video thumbnailing
RUN apk add --no-cache tzdata ffmpeg

# Copy package manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source code
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Create data directory for persistent volume mount
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Set Node environment to production
ENV NODE_ENV=production
ENV PORT=3000

# Start TeleDrive server
CMD ["node", "server.js"]
