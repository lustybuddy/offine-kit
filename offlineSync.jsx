import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import offlineStorage from '../services/offlineStorage';
import api from '../services/api';

const SyncContext = createContext();

export const useSync = () => useContext(SyncContext);

export const SyncProvider = ({ children }) => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [queue, setQueue] = useState(() => offlineStorage.getSyncQueue());
  const [conflicts, setConflicts] = useState(() => offlineStorage.getConflicts());
  const [lastSyncTime, setLastSyncTime] = useState(null);

  // Sync listener callbacks to notify active board of synced items
  const syncListenersRef = useRef(new Set());

  const registerSyncListener = useCallback((cb) => {
    syncListenersRef.current.add(cb);
    return () => syncListenersRef.current.delete(cb);
  }, []);

  const notifySyncListeners = useCallback((event) => {
    syncListenersRef.current.forEach((cb) => {
      try {
        cb(event);
      } catch (e) {
        console.error('Error notifying sync listener:', e);
      }
    });
  }, []);

  // Update online/offline status
  useEffect(() => {
    const handleOnline = () => {
      console.log('🌐 Network connection restored. Back online!');
      setIsOnline(true);
    };

    const handleOffline = () => {
      console.log('⚡ Network connection lost. Operating offline.');
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Refresh state from storage
  const reloadState = useCallback(() => {
    setQueue(offlineStorage.getSyncQueue());
    setConflicts(offlineStorage.getConflicts());
  }, []);

  // Enqueue a local offline action
  const enqueueAction = useCallback(
    (action) => {
      const item = offlineStorage.addToSyncQueue(action);
      setQueue(offlineStorage.getSyncQueue());
      return item;
    },
    []
  );

  // Core synchronization processor
  const processSyncQueue = useCallback(async () => {
    if (!navigator.onLine || isSyncing) return;

    const currentQueue = offlineStorage.getSyncQueue();
    if (!currentQueue || currentQueue.length === 0) return;

    setIsSyncing(true);
    console.log(`🔄 Starting sync for ${currentQueue.length} queued action(s)...`);

    try {
      for (const item of currentQueue) {
        try {
          if (item.type === 'CREATE_TASK') {
            const res = await api.post(`/projects/${item.projectId}/tasks`, item.payload);
            if (res.data.success) {
              const createdTask = res.data.data;
              // Replace tempId with server _id in remaining queue actions
              if (item.tempId) {
                offlineStorage.updateSyncQueueTaskIds(item.tempId, createdTask._id);

                // Update task in local storage cache
                const cached = offlineStorage.getStoredTasks(item.projectId);
                const updatedCache = cached.map((t) =>
                  t._id === item.tempId ? createdTask : t
                );
                offlineStorage.saveStoredTasks(item.projectId, updatedCache);

                notifySyncListeners({
                  type: 'TASK_CREATED_SYNCED',
                  tempId: item.tempId,
                  task: createdTask,
                });
              }
              offlineStorage.removeFromSyncQueue(item.id);
            }
          } else if (item.type === 'MOVE_TASK') {
            // If target task was a temp task that hasn't been created yet, skip until next cycle
            if (String(item.taskId).startsWith('temp_')) {
              continue;
            }

            try {
              const res = await api.patch(`/tasks/${item.taskId}/status`, {
                status: item.payload.status,
                order: item.payload.order,
                lastKnownUpdatedAt: item.lastKnownUpdatedAt,
                force: item.force || false,
              });

              if (res.data.success) {
                // Update cached task
                if (item.projectId) {
                  const cached = offlineStorage.getStoredTasks(item.projectId);
                  const updated = cached.map((t) =>
                    t._id === item.taskId ? { ...t, ...res.data.data, _syncPending: false } : t
                  );
                  offlineStorage.saveStoredTasks(item.projectId, updated);
                }
                offlineStorage.removeFromSyncQueue(item.id);
                notifySyncListeners({
                  type: 'TASK_STATUS_SYNCED',
                  taskId: item.taskId,
                  task: res.data.data,
                });
              }
            } catch (err) {
              if (err.response?.status === 409 && err.response?.data?.conflict) {
                // Conflict detected! Do not overwrite server data silently.
                console.warn('⚠️ Sync conflict on task move:', item.taskId);
                offlineStorage.addConflict({
                  type: 'MOVE_TASK',
                  taskId: item.taskId,
                  taskTitle: item.taskTitle || 'Task',
                  projectId: item.projectId,
                  originalAction: item,
                  serverTask: err.response.data.serverTask,
                  localPayload: item.payload,
                  message: err.response.data.message || 'Status was modified by another user.',
                });
                offlineStorage.removeFromSyncQueue(item.id);
              } else if (err.response?.status === 404) {
                // Task was deleted on server
                offlineStorage.removeFromSyncQueue(item.id);
              } else {
                throw err; // Network or other failure, stop processing
              }
            }
          } else if (item.type === 'UPDATE_TASK') {
            if (String(item.taskId).startsWith('temp_')) {
              continue;
            }

            try {
              const res = await api.put(`/tasks/${item.taskId}`, {
                ...item.payload,
                lastKnownUpdatedAt: item.lastKnownUpdatedAt,
                force: item.force || false,
              });

              if (res.data.success) {
                if (item.projectId) {
                  const cached = offlineStorage.getStoredTasks(item.projectId);
                  const updated = cached.map((t) =>
                    t._id === item.taskId ? { ...t, ...res.data.data, _syncPending: false } : t
                  );
                  offlineStorage.saveStoredTasks(item.projectId, updated);
                }
                offlineStorage.removeFromSyncQueue(item.id);
                notifySyncListeners({
                  type: 'TASK_UPDATED_SYNCED',
                  taskId: item.taskId,
                  task: res.data.data,
                });
              }
            } catch (err) {
              if (err.response?.status === 409 && err.response?.data?.conflict) {
                console.warn('⚠️ Sync conflict on task update:', item.taskId);
                offlineStorage.addConflict({
                  type: 'UPDATE_TASK',
                  taskId: item.taskId,
                  taskTitle: item.taskTitle || item.payload?.title || 'Task',
                  projectId: item.projectId,
                  originalAction: item,
                  serverTask: err.response.data.serverTask,
                  localPayload: item.payload,
                  message: err.response.data.message || 'Task was modified on server by another user.',
                });
                offlineStorage.removeFromSyncQueue(item.id);
              } else if (err.response?.status === 404) {
                offlineStorage.removeFromSyncQueue(item.id);
              } else {
                throw err;
              }
            }
          } else if (item.type === 'DELETE_TASK') {
            if (String(item.taskId).startsWith('temp_')) {
              // Never reached server, just remove
              offlineStorage.removeFromSyncQueue(item.id);
            } else {
              try {
                await api.delete(`/tasks/${item.taskId}`);
                offlineStorage.removeFromSyncQueue(item.id);
                notifySyncListeners({
                  type: 'TASK_DELETED_SYNCED',
                  taskId: item.taskId,
                });
              } catch (err) {
                if (err.response?.status === 404) {
                  offlineStorage.removeFromSyncQueue(item.id);
                } else {
                  throw err;
                }
              }
            }
          } else if (item.type === 'ADD_COMMENT') {
            if (String(item.taskId).startsWith('temp_')) {
              continue;
            }
            try {
              await api.post(`/tasks/${item.taskId}/comments`, item.payload);
              offlineStorage.removeFromSyncQueue(item.id);
            } catch (err) {
              if (err.response?.status === 404) {
                offlineStorage.removeFromSyncQueue(item.id);
              } else {
                throw err;
              }
            }
          }
        } catch (itemErr) {
          console.error('Error processing sync item:', item, itemErr);
          // If network failed, stop further processing in this run
          if (!navigator.onLine || itemErr.code === 'ERR_NETWORK') {
            break;
          }
        }
      }

      setLastSyncTime(new Date());
    } finally {
      setIsSyncing(false);
      reloadState();
    }
  }, [isSyncing, reloadState, notifySyncListeners]);

  // Conflict resolution handler
  const resolveConflict = useCallback(
    async (conflictId, resolution) => {
      const conflictList = offlineStorage.getConflicts();
      const conflict = conflictList.find(
        (c) => c.id === conflictId || c.taskId === conflictId
      );

      if (!conflict) return;

      if (resolution === 'keep_server') {
        // Accept server data: update local cache with serverTask
        if (conflict.projectId && conflict.serverTask) {
          const cached = offlineStorage.getStoredTasks(conflict.projectId);
          const updated = cached.map((t) =>
            t._id === conflict.taskId ? conflict.serverTask : t
          );
          offlineStorage.saveStoredTasks(conflict.projectId, updated);
          notifySyncListeners({
            type: 'CONFLICT_RESOLVED_KEEP_SERVER',
            taskId: conflict.taskId,
            task: conflict.serverTask,
          });
        }
        offlineStorage.removeConflict(conflict.id);
        reloadState();
      } else if (resolution === 'keep_local') {
        // Force local changes: re-queue with force: true
        offlineStorage.removeConflict(conflict.id);
        const forcedAction = {
          ...conflict.originalAction,
          force: true,
        };
        offlineStorage.addToSyncQueue(forcedAction);
        reloadState();
        // Immediately try syncing the forced action
        setTimeout(() => {
          processSyncQueue();
        }, 100);
      }
    },
    [notifySyncListeners, reloadState, processSyncQueue]
  );

  // Automatically trigger sync when back online or on mount if online
  useEffect(() => {
    if (isOnline && queue.length > 0) {
      processSyncQueue();
    }
  }, [isOnline]); // triggered when isOnline transitions to true

  // Periodic retry check every 20 seconds if online with pending queue
  useEffect(() => {
    const timer = setInterval(() => {
      if (navigator.onLine && offlineStorage.getSyncQueue().length > 0 && !isSyncing) {
        processSyncQueue();
      }
    }, 20000);

    return () => clearInterval(timer);
  }, [isSyncing, processSyncQueue]);

  return (
    <SyncContext.Provider
      value={{
        isOnline,
        isSyncing,
        queue,
        conflicts,
        pendingCount: queue.length,
        conflictsCount: conflicts.length,
        lastSyncTime,
        enqueueAction,
        processSyncQueue,
        resolveConflict,
        registerSyncListener,
        reloadState,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
};
