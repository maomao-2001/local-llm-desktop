import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { spawn, exec, type ChildProcess } from 'child_process'
import { Socket } from 'net'
import os from 'os'
import si from 'systeminformation'
import { promisify } from 'util'

const execAsync = promisify(exec)
let serverProcess: ChildProcess | null = null
let cachedGpuTotal = 0

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#eef2f6',
      symbolColor: '#1f2328',
      height: 32
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Register IPC handlers
  ipcMain.handle('select-model', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('check-server-status', async () => {
    return new Promise((resolve) => {
      const socket = new Socket()
      socket.setTimeout(500)
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('error', () => {
        resolve(false)
      })
      socket.connect(8080, '127.0.0.1')
    })
  })

  ipcMain.handle('start-server', async (_event, modelPath: string, contextSize: number = 2048) => {
    // Check if port is in use first
    const isRunning = await new Promise((resolve) => {
      const socket = new Socket()
      socket.setTimeout(500)
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('error', () => {
        resolve(false)
      })
      socket.connect(8080, '127.0.0.1')
    })

    if (isRunning) {
      return { success: true, message: '服务已在 8080 端口运行' }
    }

    const serverPath = is.dev
      ? join(__dirname, '../../src/main/bin/llama-server.exe')
      : join(process.resourcesPath, 'bin/llama-server.exe')

    try {
      console.log('启动服务路径：', serverPath)
      const args = [
        '-m',
        modelPath,
        '-c',
        String(contextSize),
        '--port',
        '8080',
        '--host',
        '0.0.0.0',
        '--cache-ram',
        '0'
      ]
      console.log('服务参数：', args)

      serverProcess = spawn(serverPath, args)

      serverProcess.on('error', (err) => {
        console.error('启动子进程失败：', err)
        BrowserWindow.getAllWindows().forEach((win) =>
          win.webContents.send('server-log', `启动失败：${err.message}`)
        )
        serverProcess = null
      })

      serverProcess.stdout?.on('data', (data) => {
        const log = data.toString()
        // console.log(`[llama-server]: ${log}`)
        BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('server-log', log))
      })

      serverProcess.stderr?.on('data', (data) => {
        const log = data.toString()
        console.error(`[llama-server error]: ${log}`)
        BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('server-log', log))
      })

      serverProcess.on('close', (code) => {
        console.log(`llama-server process exited with code ${code}`)
        serverProcess = null
        BrowserWindow.getAllWindows().forEach((win) =>
          win.webContents.send('server-log', `服务已退出（退出码 ${code}）`)
        )
      })

      return { success: true, message: '服务进程已启动' }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('启动服务失败：', message)
      return { success: false, message: `启动服务失败：${message}` }
    }
  })

  ipcMain.handle('stop-server', async () => {
    if (serverProcess) {
      serverProcess.kill()
      serverProcess = null
    }
    return
  })

  ipcMain.handle('get-system-stats', async () => {
    const memory = {
      total: os.totalmem(),
      used: os.totalmem() - os.freemem()
    }

    const gpu = {
      total: cachedGpuTotal,
      used: 0
    }

    try {
      // Try nvidia-smi first (returns memory in MiB)
      const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits')
      const lines = stdout.trim().split('\n')
      if (lines.length > 0) {
        // Just take the first GPU for now or sum them up?
        // Usually local LLM runs on one GPU. Let's sum if multiple.
        let totalUsed = 0
        let totalTotal = 0
        for (const line of lines) {
          const parts = line.split(',')
          if (parts.length >= 2) {
            totalUsed += parseInt(parts[0].trim()) * 1024 * 1024
            totalTotal += parseInt(parts[1].trim()) * 1024 * 1024
          }
        }
        gpu.used = totalUsed
        gpu.total = totalTotal
        cachedGpuTotal = totalTotal // Update cache
      }
    } catch {
      // Fallback to systeminformation if nvidia-smi fails
      if (cachedGpuTotal === 0) {
        try {
          const graphics = await si.graphics()
          // vram is in MB
          cachedGpuTotal = graphics.controllers.reduce((sum, c) => sum + (c.vram || 0) * 1024 * 1024, 0)
          gpu.total = cachedGpuTotal
        } catch (e) {
          console.error('Failed to get GPU info:', e)
        }
      }
      gpu.total = cachedGpuTotal
    }

    return { memory, gpu }
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill()
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
