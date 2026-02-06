import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  ColumnDef,
  flexRender,
  SortingState,
  FilterFn,
  ColumnFiltersState,
  Row,
  ColumnSizingState
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAdb } from '../hooks/useAdb'
import { useGames } from '../hooks/useGames'
import { useDownload } from '../hooks/useDownload'
import { GameInfo } from '@shared/types'
import placeholderImage from '../assets/images/game-placeholder.png'
import {
  Button,
  tokens,
  shorthands,
  makeStyles,
  Text,
  Input,
  Badge,
  ProgressBar,
  Spinner,
  Title3,
  Menu,
  MenuTrigger,
  MenuList,
  MenuItem,
  MenuPopover,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions
} from '@fluentui/react-components'
import { Tooltip } from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  DismissRegular,
  PlugDisconnectedRegular,
  CheckmarkCircleRegular,
  DesktopRegular,
  Star16Filled,
  Star16Regular,
  StarHalf16Filled,
  BatteryChargeRegular,
  StorageRegular,
  PersonRegular,
  EditRegular,
  FolderAddRegular,
  DocumentRegular,
  ChevronDownRegular,
  CopyRegular
} from '@fluentui/react-icons'
import { ArrowLeftRegular } from '@fluentui/react-icons'
import GameDetailsDialog from './GameDetailsDialog'
import { useGameDialog } from '@renderer/hooks/useGameDialog'
import MirrorSelector from './MirrorSelector'

// Column width constants
const COLUMN_WIDTHS = {
  STATUS: 60,
  THUMBNAIL: 90,
  VERSION: 180,
  POPULARITY: 120,
  SIZE: 90,
  LAST_UPDATED: 180,
  MIN_NAME_PACKAGE: 300 // Minimum width for name/package column
}

// Calculate fixed columns total width
const FIXED_COLUMNS_WIDTH =
  COLUMN_WIDTHS.STATUS +
  COLUMN_WIDTHS.THUMBNAIL +
  COLUMN_WIDTHS.VERSION +
  COLUMN_WIDTHS.POPULARITY +
  COLUMN_WIDTHS.SIZE +
  COLUMN_WIDTHS.LAST_UPDATED

type FilterType = 'all' | 'installed' | 'downloaded' | 'update'

const filterGameNameAndPackage: FilterFn<GameInfo> = (row, _columnId, filterValue) => {
  const searchStr = String(filterValue).toLowerCase()
  const gameName = String(row.original.name ?? '').toLowerCase()
  const packageName = String(row.original.packageName ?? '').toLowerCase()
  const releaseName = String(row.original.releaseName ?? '').toLowerCase()
  return (
    gameName.includes(searchStr) ||
    packageName.includes(searchStr) ||
    releaseName.includes(searchStr)
  )
}

const booleanEqualsFilter: FilterFn<GameInfo> = (row, columnId, filterValue) => {
  if (filterValue === undefined) return true
  return row.getValue(columnId) === filterValue
}

const renderPopularityStars = (value: number): React.ReactNode => {
  const normalized = Math.max(0, Math.min(100, value))
  const rating = (normalized / 100) * 5
  const filledCount = Math.floor(rating)
  const hasHalf = rating - filledCount >= 0.5

  return (
    <div style={{ display: 'inline-flex', gap: '2px' }} aria-label={`Popularity ${value}`}>
      {Array.from({ length: 5 }).map((_, index) => {
        if (index < filledCount) {
          return (
            <Star16Filled
              key={index}
              fontSize={16}
              color={tokens.colorPaletteYellowForeground2}
            />
          )
        }
        if (index === filledCount && hasHalf) {
          return (
            <StarHalf16Filled
              key={index}
              fontSize={16}
              color={tokens.colorPaletteYellowForeground2}
            />
          )
        }
        return (
          <Star16Regular key={index} fontSize={16} color={tokens.colorNeutralForeground3} />
        )
      })}
    </div>
  )
}

declare module '@tanstack/react-table' {
  interface FilterFns {
    gameNameAndPackageFilter: FilterFn<GameInfo>
  }
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 90px)',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    ...shorthands.borderBottom(tokens.strokeWidthThin, 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground3,
    flexShrink: 0
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  deviceInfoBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  connectedDeviceText: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS
  },
  deviceWarningText: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteRedForeground1
  },
  tableContainer: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    overflow: 'hidden'
  },
  toolbar: {
    marginBottom: tokens.spacingVerticalL,
    flexShrink: 0
  },
  filterButtons: {
    display: 'flex',
    gap: tokens.spacingHorizontalS
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM
  },
  searchInput: {
    width: '250px'
  },
  statusArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    ...shorthands.padding(tokens.spacingVerticalXXL),
    flexGrow: 1
  },
  progressBarContainer: {
    width: '100%',
    maxWidth: '400px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    alignItems: 'center'
  },
  tableWrapper: {
    flexGrow: 1,
    overflow: 'auto',
    position: 'relative'
  },
  namePackageCellContainer: {
    position: 'relative',
    paddingBottom: '8px',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center'
  },
  namePackageCellText: {},
  progressBarAcrossRow: {
    position: 'absolute',
    bottom: '0',
    left: '0',
    right: '0',
    height: '4px'
  },
  statusIconCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%'
  },
  resizer: {
    position: 'absolute',
    right: 0,
    top: 0,
    height: '100%',
    width: '5px',
    background: 'rgba(0, 0, 0, 0.1)',
    cursor: 'col-resize',
    userSelect: 'none',
    touchAction: 'none',
    opacity: 0,
    transition: 'opacity 0.2s ease-in-out',
    ':hover': {
      opacity: 1
    }
  },
  isResizing: {
    background: tokens.colorBrandBackground,
    opacity: 1
  }
})

interface GamesViewProps {
  onBackToDevices: () => void
}

const GamesView: React.FC<GamesViewProps> = ({ onBackToDevices }) => {
  const {
    selectedDevice,
    selectedDeviceDetails,
    isConnected,
    disconnectDevice,
    isLoading: adbLoading,
    loadPackages,
    userName,
    loadingUserName,
    setUserName
  } = useAdb()
  const {
    games,
    isLoading: loadingGames,
    error: gamesError,
    lastSyncTime,
    downloadProgress,
    extractProgress,
    refreshGames,
    getNote
  } = useGames()
  const {
    addToQueue: addDownloadToQueue,
    queue: downloadQueue,
    cancelDownload,
    retryDownload,
    deleteFiles
  } = useDownload()

  const styles = useStyles()

  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [dialogGame, setDialogGame] = useGameDialog()
  const [isDialogOpen, setIsDialogOpen] = useState<boolean>(false)
  const [tableWidth, setTableWidth] = useState<number>(0)
  const tableContainerRef = useRef<HTMLDivElement>(null)
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
  const [isEditingUserName, setIsEditingUserName] = useState<boolean>(false)
  const [editUserNameValue, setEditUserNameValue] = useState<string>('')
  const [isManualInstalling, setIsManualInstalling] = useState<boolean>(false)
  const [installStatusMessage, setInstallStatusMessage] = useState<string>('')
  const [showInstallDialog, setShowInstallDialog] = useState<boolean>(false)
  const [installSuccess, setInstallSuccess] = useState<boolean | null>(null)
  const [showObbConfirmDialog, setShowObbConfirmDialog] = useState<boolean>(false)
  const [obbFolderToConfirm, setObbFolderToConfirm] = useState<string | null>(null)

  const downloadStatusMap = useMemo(() => {
    const map = new Map<string, { status: string; progress: number }>()
    downloadQueue.forEach((item) => {
      if (item.releaseName) {
        const progress =
          item.status === 'Extracting' ? (item.extractProgress ?? 0) : (item.progress ?? 0)
        map.set(item.releaseName, {
          status: item.status,
          progress: progress
        })
      }
    })
    return map
  }, [downloadQueue])

  const counts = useMemo(() => {
    const total = games.length
    const installed = games.filter((g) => g.isInstalled).length
    const updates = games.filter((g) => g.hasUpdate).length
    const downloaded = games.filter((g) => {
      if (!g.releaseName || g.isInstalled) return false
      return downloadStatusMap.get(g.releaseName)?.status === 'Completed'
    }).length
    return { total, installed, downloaded, updates }
  }, [games, downloadStatusMap])

  useEffect(() => {
    setColumnFilters((prev) => {
      const otherFilters = prev.filter(
        (f) => f.id !== 'isInstalled' && f.id !== 'hasUpdate' && f.id !== 'isDownloaded'
      )
      switch (activeFilter) {
        case 'installed':
          return [...otherFilters, { id: 'isInstalled', value: true }]
        case 'downloaded':
          return [
            ...otherFilters,
            { id: 'isDownloaded', value: true },
            { id: 'isInstalled', value: false }
          ]
        case 'update':
          return [
            ...otherFilters,
            { id: 'isInstalled', value: true },
            { id: 'hasUpdate', value: true }
          ]
        case 'all':
        default:
          return otherFilters
      }
    })
  }, [activeFilter])

  useEffect(() => {
    const unsubscribe = window.api.adb.onInstallationCompleted((deviceId) => {
      console.log(`[GamesView] Received installation-completed event for device: ${deviceId}`)
      if (selectedDevice && deviceId === selectedDevice) {
        console.log(`[GamesView] Refreshing packages for current device ${selectedDevice}...`)
        loadPackages()
          .then(() => console.log('[GamesView] Package refresh triggered successfully.'))
          .catch((err) => console.error('[GamesView] Error triggering package refresh:', err))
      } else {
        console.log(
          `[GamesView] Installation completed event for non-selected device (${deviceId}), ignoring.`
        )
      }
    })

    return () => {
      unsubscribe()
    }
  }, [selectedDevice, loadPackages, games])

  useEffect(() => {
    if (!tableContainerRef.current) return

    // Capture current value of ref to use in cleanup
    const currentRef = tableContainerRef.current

    const updateTableWidth = (): void => {
      if (tableContainerRef.current) {
        const newWidth = tableContainerRef.current.clientWidth
        setTableWidth(newWidth)
        // Reset all column sizing to force recalculation
        setColumnSizing({})
      }
    }

    // Initial width calculation
    updateTableWidth()

    // Set up resize observer
    const resizeObserver = new ResizeObserver(() => {
      // Use requestAnimationFrame to avoid too many updates
      window.requestAnimationFrame(updateTableWidth)
    })
    resizeObserver.observe(currentRef)

    // Also listen for window resize as a fallback
    const handleResize = (): void => {
      window.requestAnimationFrame(updateTableWidth)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      resizeObserver.unobserve(currentRef)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const columns = useMemo<ColumnDef<GameInfo>[]>(() => {
    // Calculate dynamic width for name column, with a minimum width
    const nameColumnWidth = Math.max(
      COLUMN_WIDTHS.MIN_NAME_PACKAGE,
      tableWidth - FIXED_COLUMNS_WIDTH - 5 // 5px buffer
    )

    return [
      {
        id: 'downloadStatus',
        header: '',
        size: COLUMN_WIDTHS.STATUS,
        enableResizing: false,
        enableSorting: false,
        cell: ({ row }) => {
          const game = row.original
          const downloadInfo = game.releaseName
            ? downloadStatusMap.get(game.releaseName)
            : undefined
          const isDownloaded = downloadInfo?.status === 'Completed'
          const isInstalled = game.isInstalled
          const isUpdateAvailable = game.hasUpdate

          return (
            <div className={styles.statusIconCell}>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
                {isDownloaded && (
                  <Tooltip content="Stored Locally" relationship="label">
                    <span>
                      <DesktopRegular
                        fontSize={16}
                        color={tokens.colorNeutralForeground3}
                        aria-label="Stored Locally"
                      />
                    </span>
                  </Tooltip>
                )}
                {isInstalled && (
                  <Tooltip content="Installed" relationship="label">
                    <span>
                      <CheckmarkCircleRegular
                        fontSize={16}
                        color={tokens.colorPaletteGreenForeground1}
                        aria-label="Installed"
                      />
                    </span>
                  </Tooltip>
                )}
                {isUpdateAvailable && (
                  <ArrowClockwiseRegular
                    fontSize={16}
                    color={tokens.colorPaletteGreenForeground1}
                    aria-label="Update Available"
                  />
                )}
              </div>
            </div>
          )
        }
      },
      {
        accessorKey: 'thumbnailPath',
        header: ' ',
        size: COLUMN_WIDTHS.THUMBNAIL,
        enableResizing: false,
        cell: ({ getValue }) => {
          const pathValue = getValue()
          const imagePath = typeof pathValue === 'string' ? pathValue : ''
          return (
            <div className="game-thumbnail-cell">
              <img
                src={imagePath ? `file://${imagePath}` : placeholderImage}
                alt="Thumbnail"
                className="game-thumbnail-img"
              />
            </div>
          )
        },
        enableSorting: false
      },
      {
        accessorKey: 'name',
        header: 'Name / Package',
        size: nameColumnWidth > 0 ? nameColumnWidth : COLUMN_WIDTHS.MIN_NAME_PACKAGE,
        cell: ({ row }) => {
          const game = row.original
          const downloadInfo = game.releaseName
            ? downloadStatusMap.get(game.releaseName)
            : undefined
          const isDownloading = downloadInfo?.status === 'Downloading'
          const isExtracting = downloadInfo?.status === 'Extracting'
          const isQueued = downloadInfo?.status === 'Queued'
          const isInstalling = downloadInfo?.status === 'Installing'
          const isInstallError = downloadInfo?.status === 'InstallError'

          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                height: '100%',
                position: 'relative',
                paddingBottom: '8px'
              }}
            >
              <div style={{ marginBottom: tokens.spacingVerticalXS }}>
                {' '}
                <div className="game-name-main">{game.name}</div>
                <div className="game-package-sub">{game.releaseName}</div>
                <div className="game-package-sub">{game.packageName}</div>
              </div>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}
              >
                {isQueued && (
                  <Badge shape="rounded" color="informative" appearance="outline">
                    Queued
                  </Badge>
                )}
                {(isDownloading || isExtracting || isInstalling) && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacingHorizontalXS
                    }}
                  >
                    <Spinner size="tiny" aria-label="Installing" />
                    <Badge shape="rounded" color="brand" appearance="outline">
                      {downloadInfo?.status}
                    </Badge>
                  </div>
                )}
                {isInstallError && (
                  <Badge shape="rounded" color="danger" appearance="outline">
                    Install Error
                  </Badge>
                )}
              </div>
              {(isDownloading || isExtracting || isInstalling) && downloadInfo && (
                <ProgressBar
                  value={downloadInfo.progress}
                  max={100}
                  shape="rounded"
                  thickness="medium"
                  className={styles.progressBarAcrossRow}
                  aria-label={isDownloading ? 'Download progress' : 'Extraction progress'}
                />
              )}
            </div>
          )
        },
        enableResizing: true
      },
      {
        accessorKey: 'version',
        header: 'Version',
        size: COLUMN_WIDTHS.VERSION,
        cell: ({ row }) => {
          const listVersion = row.original.version
          const isInstalled = row.original.isInstalled
          const deviceVersion = row.original.deviceVersionCode
          const displayListVersion = listVersion ? `v${listVersion}` : '-'
          return (
            <div className="version-cell">
              <div className="list-version-main">{displayListVersion}</div>
              {isInstalled && (
                <div className="installed-version-info">
                  {deviceVersion !== undefined ? `Installed: v${deviceVersion}` : 'Installed'}
                </div>
              )}
            </div>
          )
        },
        enableResizing: true
      },
      {
        accessorKey: 'downloads',
        header: 'Popularity',
        size: COLUMN_WIDTHS.POPULARITY,
        cell: (info) => {
          const count = info.getValue()
          return typeof count === 'number' ? renderPopularityStars(count) : '-'
        },
        enableResizing: true
      },
      {
        accessorKey: 'size',
        header: 'Size',
        size: COLUMN_WIDTHS.SIZE,
        cell: (info) => info.getValue() || '-',
        enableResizing: true
      },
      {
        accessorKey: 'lastUpdated',
        header: 'Last Updated',
        size: COLUMN_WIDTHS.LAST_UPDATED,
        cell: (info) => info.getValue() || '-',
        enableResizing: true
      },
      {
        accessorKey: 'isInstalled',
        header: 'Installed Status',
        enableResizing: false,
        filterFn: 'booleanEquals'
      },
      {
        accessorKey: 'hasUpdate',
        header: 'Update Status',
        enableResizing: false,
        filterFn: 'booleanEquals'
      },
      {
        id: 'isDownloaded',
        header: 'Downloaded Status',
        accessorFn: (row) => {
          if (!row.releaseName) return false
          return downloadStatusMap.get(row.releaseName)?.status === 'Completed'
        },
        enableResizing: false,
        filterFn: 'booleanEquals'
      }
    ]
  }, [downloadStatusMap, styles, tableWidth])

  const table = useReactTable({
    data: games,
    columns,
    columnResizeMode: 'onChange',
    filterFns: {
      gameNameAndPackageFilter: filterGameNameAndPackage,
      booleanEquals: booleanEqualsFilter
    },
    state: {
      sorting,
      globalFilter,
      columnFilters,
      columnVisibility: { isInstalled: false, hasUpdate: false, isDownloaded: false },
      columnSizing
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    globalFilterFn: 'gameNameAndPackageFilter',
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel()
  })

  const { rows } = table.getRowModel()
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 115,
    overscan: 10
  })

  const formatDate = (date: Date | null): string => {
    if (!date) return 'Never'
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  }

  const getProcessMessage = (): string => {
    if (downloadProgress > 0 && downloadProgress < 100) {
      return `Downloading game data... ${downloadProgress}%`
    } else if (extractProgress > 0 && extractProgress < 100) {
      return `Extracting game data... ${extractProgress}%`
    } else if (loadingGames) {
      return 'Preparing game library...'
    }
    return ''
  }

  const getCurrentProgress = (): number => {
    if (downloadProgress > 0 && downloadProgress < 100) {
      return downloadProgress
    } else if (extractProgress > 0 && extractProgress < 100) {
      return extractProgress
    }
    return 0
  }

  const handleRowClick = (
    _event: React.MouseEvent<HTMLTableRowElement>,
    row: Row<GameInfo>
  ): void => {
    console.log('Row clicked for game:', row.original.name)
    setDialogGame(row.original)
    setIsDialogOpen(true)
  }

  useEffect(() => {
    if (dialogGame) {
      setIsDialogOpen(true)
    }
  }, [dialogGame])

  const handleCloseDialog = useCallback((): void => {
    setIsDialogOpen(false)
    setTimeout(() => {
      setDialogGame(null)
    }, 300)
  }, [setDialogGame])

  const handleInstall = (game: GameInfo): void => {
    if (!game) return
    console.log('Install action triggered for:', game.packageName)
    addDownloadToQueue(game)
      .then((success) => {
        if (success) {
          console.log(`Successfully added ${game.releaseName} to download queue.`)
        } else {
          console.log(`Failed to add ${game.releaseName} to queue (might already exist).`)
        }
      })
      .catch((err) => {
        console.error('Error adding to queue:', err)
      })
  }

  const handleUninstall = async (game: GameInfo): Promise<void> => {
    if (!game || !game.packageName || !selectedDevice) {
      console.error(
        'Uninstall action aborted: Missing game data, package name, or selectedDevice.',
        {
          game,
          selectedDevice
        }
      )
      window.alert('Cannot start uninstall: Essential information is missing.')
      return
    }

    console.log(`Uninstall: Starting for ${game.name} (${game.packageName}) on ${selectedDevice}.`)
    setIsLoading(true)

    try {
      const success = await window.api.adb.uninstallPackage(selectedDevice, game.packageName)
      if (success) {
        console.log(`Uninstall: Successfully uninstalled ${game.packageName}.`)
      } else {
        console.error(`Uninstall: Failed to uninstall ${game.packageName}.`)
        window.alert('Failed to uninstall the game.')
      }
      await loadPackages()
    } catch (error) {
      console.error(`Uninstall: Error during process for ${game.name}:`, error)
      window.alert(
        `An error occurred during the uninstall process for ${game.name}. Please check logs.`
      )
    } finally {
      setIsLoading(false)
    }
  }

  const handleReinstall = async (game: GameInfo): Promise<void> => {
    if (!game || !game.packageName || !game.releaseName || !selectedDevice) {
      console.error(
        'Reinstall Error: Missing game data, package name, release name, or device ID.',
        {
          game,
          selectedDevice
        }
      )
      window.alert('Cannot start reinstall: Essential information is missing.')
      return
    }

    console.log(`Reinstall: Starting for ${game.name} (${game.packageName}) on ${selectedDevice}.`)
    setIsLoading(true)

    try {
      // Step 1: Uninstall the package
      console.log(`Reinstall: Attempting to uninstall ${game.packageName}...`)
      const uninstallSuccess = await window.api.adb.uninstallPackage(
        selectedDevice,
        game.packageName
      )

      if (uninstallSuccess) {
        console.log(`Reinstall: Successfully uninstalled ${game.packageName}.`)
        // The game is now uninstalled from the device.
        // Downloaded files (if any) should still be present.

        const downloadInfo = downloadStatusMap.get(game.releaseName)

        if (downloadInfo?.status === 'Completed') {
          console.log(
            `Reinstall: Files for ${game.releaseName} are 'Completed'. Initiating install from completed.`
          )
          await window.api.downloads.installFromCompleted(game.releaseName, selectedDevice)
          console.log(`Reinstall: 'installFromCompleted' called for ${game.releaseName}.`)
        } else {
          console.log(
            `Reinstall: Files for ${game.releaseName} not 'Completed' (status: ${downloadInfo?.status}). Adding to download queue.`
          )
          const addToQueueSuccess = await addDownloadToQueue(game)
          if (addToQueueSuccess) {
            console.log(`Reinstall: Successfully added ${game.releaseName} to download queue.`)
          } else {
            console.warn(
              `Reinstall: Failed to add ${game.releaseName} to queue. Current status: ${downloadInfo?.status}.`
            )
            window.alert(
              `Reinstall for ${game.name} failed: Could not add to download queue. Please check logs.`
            )
          }
        }
      } else {
        console.error(
          `Reinstall: Failed to uninstall ${game.packageName}. Installation step will be skipped.`
        )
        window.alert(`Failed to uninstall ${game.name}. Reinstall aborted.`)
      }
    } catch (error) {
      console.error(`Reinstall: Error during process for ${game.name}:`, error)
      window.alert(
        `An error occurred during the reinstall process for ${game.name}. Please check logs.`
      )
    } finally {
      setIsLoading(false)
      // Refresh packages to update UI. The 'installation-completed' event should also trigger this,
      // but it's good to have a fallback or an immediate refresh after the uninstall part.
      console.log(`Reinstall: Process finished for ${game.name}. Triggering package refresh.`)
      loadPackages().catch((err) =>
        console.error('Reinstall: Error refreshing packages post-operation:', err)
      )
    }
  }

  const handleUpdate = async (game: GameInfo): Promise<void> => {
    if (!game || !game.releaseName || !selectedDevice) {
      console.error('Update action aborted: Missing game data, releaseName, or selectedDevice.', {
        game,
        selectedDevice
      })
      window.alert('Cannot start update: Essential information is missing.')
      handleCloseDialog()
      return
    }

    console.log(
      `Update action triggered for: ${game.name} (${game.packageName}) on ${selectedDevice}`
    )

    try {
      const downloadInfo = downloadStatusMap.get(game.releaseName)

      if (downloadInfo?.status === 'Completed') {
        console.log(
          `Update for ${game.releaseName}: Files are already 'Completed'. Initiating install from completed.`
        )
        await window.api.downloads.installFromCompleted(game.releaseName, selectedDevice)
        console.log(`Update: 'installFromCompleted' called for ${game.releaseName}.`)
        // Optionally, refresh packages or rely on 'installation-completed' event
        // loadPackages().catch(err => console.error('Update: Error refreshing packages post-install:', err));
      } else {
        console.log(
          `Update for ${game.releaseName}: Files not 'Completed' (status: ${downloadInfo?.status}). Adding to download queue.`
        )
        const addToQueueSuccess = await addDownloadToQueue(game)
        if (addToQueueSuccess) {
          console.log(`Update: Successfully added ${game.releaseName} to download queue.`)
        } else {
          console.warn(
            `Update: Failed to add ${game.releaseName} to queue. Current status: ${downloadInfo?.status}.`
          )
          window.alert(
            `Could not queue ${game.name} for update. It might already be in the queue or an error occurred. Please check logs.`
          )
        }
      }
    } catch (error) {
      console.error(`Update: Error during process for ${game.name}:`, error)
      window.alert(
        `An error occurred during the update process for ${game.name}. Please check logs.`
      )
    }
  }

  const handleRetry = (game: GameInfo): void => {
    if (!game || !game.releaseName) return
    console.log('Retry action triggered for:', game.releaseName)
    retryDownload(game.releaseName)
  }

  const handleCancelDownload = (game: GameInfo): void => {
    if (!game || !game.releaseName) return
    console.log('Cancel download/extraction action triggered for:', game.releaseName)
    cancelDownload(game.releaseName)
  }

  const handleInstallFromCompleted = (game: GameInfo): void => {
    if (!game || !game.releaseName || !selectedDevice) {
      console.error('Missing game, releaseName, or deviceId for install from completed action')
      window.alert('Cannot start installation: Missing required information.')
      return
    }
    console.log(`Requesting install from completed for ${game.releaseName} on ${selectedDevice}`)
    window.api.downloads.installFromCompleted(game.releaseName, selectedDevice).catch((err) => {
      console.error('Error triggering install from completed:', err)
      window.alert('Failed to start installation. Please check the main process logs.')
    })
  }

  const handleDeleteDownloaded = useCallback(
    async (game: GameInfo | null): Promise<void> => {
      if (!game || !game.releaseName) return
      console.log('Delete downloaded files action triggered for:', game.releaseName)
      try {
        const success = await deleteFiles(game.releaseName)
        if (success) {
          console.log(`Successfully requested deletion of files for ${game.releaseName}.`)
        } else {
          console.error(`Failed to delete files for ${game.releaseName}.`)
          window.alert('Failed to delete downloaded files. Check logs.')
        }
      } catch (error) {
        console.error('Error calling deleteFiles:', error)
        window.alert('An error occurred while trying to delete downloaded files.')
      }
      handleCloseDialog()
    },
    [deleteFiles, handleCloseDialog]
  )

  const handleEditUserName = useCallback(() => {
    setEditUserNameValue(userName)
    setIsEditingUserName(true)
  }, [userName])

  const handleSaveUserName = useCallback(async () => {
    if (!editUserNameValue.trim()) return

    try {
      await setUserName(editUserNameValue.trim())
      setIsEditingUserName(false)
    } catch (error) {
      console.error('Error setting user name:', error)
      window.alert('Failed to set user name. Please try again.')
    }
  }, [editUserNameValue, setUserName])

  const handleCancelEditUserName = useCallback(() => {
    setIsEditingUserName(false)
    setEditUserNameValue('')
  }, [])

  const handleManualInstall = useCallback(
    async (type: 'apk' | 'folder') => {
      if (!isConnected || !selectedDevice) {
        window.alert('Please connect to a device first.')
        return
      }

      try {
        let filePath: string | null = null
        let itemName: string = ''

        if (type === 'apk') {
          filePath = await window.api.dialog.showApkFilePicker()
          itemName = 'APK file'
        } else {
          filePath = await window.api.dialog.showFolderPicker()
          itemName = 'folder'
        }

        if (!filePath) {
          return // User cancelled the dialog
        }

        const fileName = filePath.split(/[/\\]/).pop() || filePath
        console.log(`${itemName} install requested for: ${filePath}`)

        // Show the installation dialog
        setShowInstallDialog(true)
        setIsManualInstalling(true)
        setInstallStatusMessage(`Installing ${itemName}: ${fileName}...`)
        setInstallSuccess(null)

        const success = await window.api.downloads.installManualFile(filePath, selectedDevice)

        setInstallSuccess(success)

        if (success) {
          console.log(`${itemName} installation successful for: ${filePath}`)
          setInstallStatusMessage(`✅ "${fileName}" installed successfully!`)
          // Refresh packages to update the UI
          await loadPackages()
        } else {
          console.error(`${itemName} installation failed for: ${filePath}`)
          setInstallStatusMessage(`❌ Failed to install "${fileName}"`)
        }
      } catch (error) {
        console.error(`Error during ${type} installation:`, error)
        setInstallStatusMessage('❌ Installation error occurred')
        setInstallSuccess(false)
      } finally {
        setIsManualInstalling(false)
      }
    },
    [isConnected, selectedDevice, loadPackages]
  )

  const handleCopyObbFolder = useCallback(async () => {
    if (!isConnected || !selectedDevice) {
      window.alert('Please connect to a device first.')
      return
    }

    try {
      const folderPath = await window.api.dialog.showFolderPicker()

      if (!folderPath) {
        return // User cancelled the dialog
      }

      const folderName = folderPath.split(/[/\\]/).pop() || folderPath
      console.log(`OBB folder copy requested for: ${folderPath}`)

      // Check if there's a corresponding package installed
      try {
        const installedPackages = await window.api.adb.getInstalledPackages(selectedDevice)
        const matchingPackage = installedPackages.find((pkg) => pkg.packageName === folderName)
        console.log('installedPackages', installedPackages)
        console.log('matchingPackage', matchingPackage)
        if (!matchingPackage) {
          // No matching package found, show confirmation dialog
          console.log(`No matching package found for folder: ${folderName}`)
          setObbFolderToConfirm(folderPath)
          setShowObbConfirmDialog(true)
          return
        }

        console.log(`Found matching package for folder: ${folderName}`)
      } catch (error) {
        console.error('Error checking installed packages:', error)
        // If we can't check packages, show a warning but let user proceed
        const proceed = window.confirm(
          `Could not verify installed packages. Do you want to proceed with copying "${folderName}" to the OBB directory?`
        )
        if (!proceed) {
          return
        }
      }

      // Proceed with copying
      await performObbCopy(folderPath)
    } catch (error) {
      console.error(`Error during OBB folder copy:`, error)
      setInstallStatusMessage('❌ OBB copy error occurred')
      setInstallSuccess(false)
      setShowInstallDialog(true)
      setIsManualInstalling(false)
    }
  }, [isConnected, selectedDevice])

  const performObbCopy = useCallback(
    async (folderPath: string) => {
      if (!selectedDevice) return

      const folderName = folderPath.split(/[/\\]/).pop() || folderPath

      // Show the installation dialog
      setShowInstallDialog(true)
      setIsManualInstalling(true)
      setInstallStatusMessage(`Copying OBB folder: ${folderName}...`)
      setInstallSuccess(null)

      try {
        const success = await window.api.downloads.copyObbFolder(folderPath, selectedDevice)

        setInstallSuccess(success)

        if (success) {
          console.log(`OBB folder copy successful for: ${folderPath}`)
          setInstallStatusMessage(`✅ "${folderName}" copied to OBB directory successfully!`)
        } else {
          console.error(`OBB folder copy failed for: ${folderPath}`)
          setInstallStatusMessage(`❌ Failed to copy "${folderName}" to OBB directory`)
        }
      } catch (error) {
        console.error(`Error during OBB folder copy:`, error)
        setInstallStatusMessage('❌ OBB copy error occurred')
        setInstallSuccess(false)
      } finally {
        setIsManualInstalling(false)
      }
    },
    [selectedDevice]
  )

  const handleObbConfirmCopy = useCallback(async () => {
    if (!obbFolderToConfirm) return

    setShowObbConfirmDialog(false)
    await performObbCopy(obbFolderToConfirm)
    setObbFolderToConfirm(null)
  }, [obbFolderToConfirm, performObbCopy])

  const handleObbCancelCopy = useCallback(() => {
    setShowObbConfirmDialog(false)
    setObbFolderToConfirm(null)
  }, [])

  const closeInstallDialog = useCallback(() => {
    setShowInstallDialog(false)
    setInstallSuccess(null)
    setInstallStatusMessage('')
  }, [])

  const isBusy = adbLoading || loadingGames || isLoading || isManualInstalling

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={onBackToDevices}>
            Devices selection
          </Button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Title3>{selectedDeviceDetails?.friendlyModelName || 'Games'}</Title3>
              {selectedDeviceDetails && (
                <>
                  {selectedDeviceDetails?.batteryLevel !== null && (
                    <Badge
                      appearance="outline"
                      color={selectedDeviceDetails.batteryLevel > 20 ? 'success' : 'danger'}
                      icon={<BatteryChargeRegular />}
                    >
                      {selectedDeviceDetails.batteryLevel}%
                    </Badge>
                  )}
                  {selectedDeviceDetails?.storageFree && (
                    <Badge appearance="outline" icon={<StorageRegular />}>
                      {selectedDeviceDetails.storageFree} free
                    </Badge>
                  )}
                </>
              )}
            </div>
            {isConnected && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}
              >
                {isEditingUserName ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacingHorizontalXS
                    }}
                  >
                    <Input
                      value={editUserNameValue}
                      onChange={(e) => setEditUserNameValue(e.target.value)}
                      placeholder="Enter your VR gaming name"
                      size="small"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleSaveUserName()
                        } else if (e.key === 'Escape') {
                          handleCancelEditUserName()
                        }
                      }}
                      autoFocus
                    />
                    <Button
                      appearance="subtle"
                      size="small"
                      onClick={handleSaveUserName}
                      disabled={loadingUserName || !editUserNameValue.trim()}
                    >
                      {loadingUserName ? <Spinner size="tiny" /> : 'Save'}
                    </Button>
                    <Button
                      appearance="subtle"
                      size="small"
                      onClick={handleCancelEditUserName}
                      disabled={loadingUserName}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacingHorizontalXS
                    }}
                  >
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                      Username in Multiplayer Games:
                    </Text>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<PersonRegular />}
                      iconPosition="before"
                      onClick={handleEditUserName}
                      style={{
                        minHeight: 'auto',
                        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
                        borderRadius: tokens.borderRadiusMedium,
                        border: `1px solid ${tokens.colorNeutralStroke2}`,
                        backgroundColor: tokens.colorNeutralBackground1
                      }}
                      title="Click to change your VR gaming name (appears in games and apps)"
                    >
                      {userName || 'Click to set'}
                      <EditRegular
                        style={{ marginLeft: tokens.spacingHorizontalXS, fontSize: '12px' }}
                      />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacingVerticalS,
            alignItems: 'flex-end'
          }}
        >
          <MirrorSelector />
          {isConnected ? (
            <div className={styles.toolbarRight}>
              <Text className={styles.connectedDeviceText}>
                <CheckmarkCircleRegular />
                Connected to: {selectedDevice}
              </Text>
              <Button
                appearance="subtle"
                icon={<PlugDisconnectedRegular />}
                onClick={disconnectDevice}
                title="Disconnect from device"
              />
            </div>
          ) : (
            <div className={styles.toolbarRight}>
              <Text className={styles.deviceWarningText}>
                <DismissRegular />
                Not connected to a device
              </Text>
            </div>
          )}
        </div>
      </div>

      <div className={styles.tableContainer}>
        <div className="games-toolbar">
          <div className="games-toolbar-left">
            <Button icon={<ArrowClockwiseRegular />} onClick={refreshGames} disabled={isBusy}>
              {isBusy ? 'Working...' : 'Refresh Games'}
            </Button>
            <Button
              icon={<ArrowClockwiseRegular />}
              onClick={() => loadPackages()}
              disabled={isBusy || !isConnected}
              title={
                !isConnected
                  ? 'Connect a device to refresh its packages'
                  : 'Refresh installed packages on the device'
              }
            >
              {isBusy ? 'Working...' : 'Refresh Quest'}
            </Button>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  icon={<FolderAddRegular />}
                  iconPosition="before"
                  disabled={isBusy || !isConnected}
                  title={
                    !isConnected
                      ? 'Connect a device to manually install files'
                      : 'Install APK file or folder manually'
                  }
                >
                  {isManualInstalling ? 'Installing...' : 'Manual Install'}
                  <ChevronDownRegular />
                </Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem
                    icon={<DocumentRegular />}
                    onClick={() => handleManualInstall('apk')}
                    disabled={isManualInstalling}
                  >
                    Install APK File
                  </MenuItem>
                  <MenuItem
                    icon={<FolderAddRegular />}
                    onClick={() => handleManualInstall('folder')}
                    disabled={isManualInstalling}
                  >
                    Install Folder
                  </MenuItem>
                  <MenuItem
                    icon={<CopyRegular />}
                    onClick={handleCopyObbFolder}
                    disabled={isManualInstalling}
                  >
                    Copy OBB Folder
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
            <span className="last-synced">Last synced: {formatDate(lastSyncTime)}</span>
            {isConnected && (
              <div className="filter-buttons">
                <button
                  onClick={() => setActiveFilter('all')}
                  className={activeFilter === 'all' ? 'active' : ''}
                >
                  All ({counts.total})
                </button>
                <button
                  onClick={() => setActiveFilter('installed')}
                  className={activeFilter === 'installed' ? 'active' : ''}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <Tooltip content="Installed" relationship="label">
                      <span>
                        <CheckmarkCircleRegular
                          fontSize={16}
                          color={
                            activeFilter === 'installed'
                              ? tokens.colorPaletteGreenForeground1
                              : tokens.colorNeutralForeground3
                          }
                          aria-label="Installed"
                        />
                      </span>
                    </Tooltip>
                    Installed ({counts.installed})
                  </span>
                </button>
                <button
                  onClick={() => setActiveFilter('downloaded')}
                  className={activeFilter === 'downloaded' ? 'active' : ''}
                  disabled={counts.downloaded === 0}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <Tooltip content="Stored Locally" relationship="label">
                      <span>
                        <DesktopRegular
                          fontSize={16}
                          color={
                            activeFilter === 'downloaded'
                              ? tokens.colorNeutralForeground2
                              : tokens.colorNeutralForeground3
                          }
                          aria-label="Stored Locally"
                        />
                      </span>
                    </Tooltip>
                    Ready to Install ({counts.downloaded})
                  </span>
                </button>
                <button
                  onClick={() => setActiveFilter('update')}
                  className={activeFilter === 'update' ? 'active' : ''}
                  disabled={counts.updates === 0}
                >
                  Updates ({counts.updates})
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="games-toolbar-right">
          <span className="game-count">{table.getFilteredRowModel().rows.length} displayed</span>
          <Input
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(String(e.target.value))}
            placeholder="Search name/package..."
            type="search"
          />
        </div>
        {isBusy && !loadingGames && !downloadProgress && !extractProgress && (
          <div className="loading-indicator">Processing...</div>
        )}

        {installStatusMessage && <div className="loading-indicator">{installStatusMessage}</div>}

        {loadingGames && (downloadProgress > 0 || extractProgress > 0) && (
          <div className="download-progress">
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${getCurrentProgress()}%` }} />
            </div>
            <div className="progress-text">{getProcessMessage()}</div>
          </div>
        )}

        {loadingGames ? (
          <div className="loading-indicator">Loading games library...</div>
        ) : gamesError ? (
          <div className="error-message">{gamesError}</div>
        ) : games.length === 0 && !loadingGames ? (
          <div className="no-games-message">
            No games found. Click &quot;Refresh Games&quot; to sync the game library.
          </div>
        ) : (
          <>
            <div className="table-wrapper" ref={tableContainerRef}>
              <table className="games-table" style={{ width: table.getTotalSize() }}>
                <thead
                  style={{
                    display: 'grid',
                    position: 'sticky',
                    top: 0,
                    zIndex: 1
                  }}
                >
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          colSpan={header.colSpan}
                          style={{ width: header.getSize(), position: 'relative' }}
                        >
                          {header.isPlaceholder ? null : (
                            <div
                              {...{
                                className: header.column.getCanSort()
                                  ? 'cursor-pointer select-none'
                                  : '',
                                onClick: header.column.getToggleSortingHandler()
                              }}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: ' 🔼',
                                desc: ' 🔽'
                              }[header.column.getIsSorted() as string] ?? null}
                            </div>
                          )}
                          {header.column.getCanResize() && (
                            <div
                              onMouseDown={header.getResizeHandler()}
                              onTouchStart={header.getResizeHandler()}
                              className={`${styles.resizer} ${header.column.getIsResizing() ? styles.isResizing : ''}`}
                            />
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody
                  style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index] as Row<GameInfo>
                    const rowClasses = [
                      row.original.isInstalled ? 'row-installed' : 'row-not-installed',
                      row.original.hasUpdate ? 'row-update-available' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')

                    return (
                      <tr
                        key={row.id}
                        className={rowClasses}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`
                        }}
                        onClick={(e) => handleRowClick(e, row)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            style={{
                              width: cell.column.getSize(),
                              maxWidth: cell.column.getSize()
                            }}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {dialogGame && (
              <GameDetailsDialog
                game={dialogGame}
                open={isDialogOpen}
                onClose={handleCloseDialog}
                downloadStatusMap={downloadStatusMap}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
                onReinstall={handleReinstall}
                onUpdate={handleUpdate}
                onRetry={handleRetry}
                onCancelDownload={handleCancelDownload}
                onDeleteDownloaded={handleDeleteDownloaded}
                onInstallFromCompleted={handleInstallFromCompleted}
                getNote={getNote}
                isConnected={isConnected}
                isBusy={isBusy}
              />
            )}

            {/* Manual Installation Progress Dialog */}
            <Dialog
              open={showInstallDialog}
              onOpenChange={(_, data) => !data.open && closeInstallDialog()}
            >
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Manual Operation</DialogTitle>
                  <DialogContent>
                    <div style={{ marginBottom: tokens.spacingVerticalM }}>
                      <Text>{installStatusMessage}</Text>
                    </div>
                    {isManualInstalling && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: tokens.spacingHorizontalS,
                          marginBottom: tokens.spacingVerticalM
                        }}
                      >
                        <Spinner size="small" />
                        <Text>Processing...</Text>
                      </div>
                    )}
                    {installSuccess !== null && (
                      <div
                        style={{
                          marginTop: tokens.spacingVerticalM,
                          padding: tokens.spacingVerticalS,
                          borderRadius: tokens.borderRadiusMedium,
                          backgroundColor: installSuccess
                            ? tokens.colorPaletteGreenBackground1
                            : tokens.colorPaletteRedBackground1,
                          color: installSuccess
                            ? tokens.colorPaletteGreenForeground1
                            : tokens.colorPaletteRedForeground1
                        }}
                      >
                        <Text weight="semibold">
                          {installSuccess ? '✅ Operation Successful!' : '❌ Operation Failed'}
                        </Text>
                        {!installSuccess && (
                          <div style={{ marginTop: tokens.spacingVerticalXS }}>
                            <Text size={200}>Please check the logs for more details.</Text>
                          </div>
                        )}
                      </div>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button
                      appearance="primary"
                      onClick={closeInstallDialog}
                      disabled={isManualInstalling}
                    >
                      {isManualInstalling ? 'Processing...' : 'Close'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* OBB Folder Confirmation Dialog */}
            <Dialog
              open={showObbConfirmDialog}
              onOpenChange={(_, data) => !data.open && handleObbCancelCopy()}
            >
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Confirm OBB Folder Copy</DialogTitle>
                  <DialogContent>
                    <div style={{ marginBottom: tokens.spacingVerticalM }}>
                      <Text>
                        No corresponding package was found for folder &quot;
                        {obbFolderToConfirm?.split(/[/\\]/).pop()}&quot;.
                      </Text>
                      <div style={{ marginTop: tokens.spacingVerticalS }}>
                        <Text>
                          Do you still want to copy this folder to the OBB directory? This is
                          usually only useful if the matching app is already installed.
                        </Text>
                      </div>
                    </div>
                  </DialogContent>
                  <DialogActions>
                    <Button
                      appearance="primary"
                      onClick={handleObbConfirmCopy}
                      disabled={isManualInstalling}
                    >
                      Copy Anyway
                    </Button>
                    <Button
                      appearance="secondary"
                      onClick={handleObbCancelCopy}
                      disabled={isManualInstalling}
                    >
                      Cancel
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </>
        )}
      </div>
    </div>
  )
}

export default GamesView
