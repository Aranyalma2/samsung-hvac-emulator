# Use an official Node runtime as the base image. Adjust the Node version if needed.
FROM node:18

# Set the working directory in the container.
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install Node dependencies.
RUN npm install

# Copy the rest of the application files.
COPY . .

# Expose the ports for the web server (3000) and the modbus server (8502)
EXPOSE 3000
EXPOSE 8502

# Start the application.
CMD ["npm", "start"]