# Process Scheduling in the Tarn Kernel

This guide explains how the Tarn kernel, a general-purpose operating system kernel used in our lab clusters, decides which process runs on which processor and for how long. It is written for operators who need to reason about latency complaints, not for kernel developers. The parameter names and defaults below apply to Tarn 6.2; earlier releases used different names for several of them.

## Run queues

Every processor core owns a private run queue that holds the tasks ready to execute on that core. Keeping the queues per core avoids a single global lock, which would become a bottleneck on machines with dozens of cores. A task that is sleeping on disk input, a timer or a lock is not on any run queue; it is moved back only when the event it waits for arrives.

Because queues are private, they can drift out of balance: one core may hold nine runnable tasks while its neighbor sits idle. A periodic balancer corrects this. Every 4 milliseconds on a busy core, and immediately when a core is about to go idle, the balancer compares queue lengths inside a scheduling domain and pulls tasks from the longest queue. It prefers to migrate tasks that have not run recently, since their cached data is probably gone from the old core anyway.

## Time slices and virtual runtime

The default scheduling class does not hand out fixed quanta. Instead it tracks a virtual runtime for each task, which is the processor time the task has consumed divided by its weight. The scheduler always picks the task with the smallest virtual runtime, so a task that has been starved of processor time naturally moves to the front of the line.

The length of one turn is derived from sched_base_slice_us, which defaults to 3000 microseconds. When more than eight tasks share a queue, the slice is not shrunk further; the scheduling period is stretched instead, so that context switching overhead stays bounded. Shorter slices improve responsiveness for interactive work, while longer slices help batch throughput because caches stay warm.

## Priorities and nice values

Ordinary tasks carry a nice value between -20 and 19. A lower number means a larger share of the processor. Nice values are translated into weights: nice 0 maps to a weight of 1024, and each step of one changes the weight by roughly 25 percent. Two tasks that differ by one nice level therefore split a contended core about 55 to 45 rather than one of them winning outright.

Important consequences:

- Nice values express a relative share, not a guarantee. A nice 19 task on an otherwise idle core still gets the whole core.
- Raising priority below nice 0 requires the CAP_SCHED_BOOST capability; lowering priority never does.
- Group scheduling applies weights to whole control groups first, and only then to the tasks inside each group.

## Preemption and wakeups

A running task loses the processor in three ways: it blocks voluntarily, its slice expires at the next timer tick, or a task with a much smaller virtual runtime wakes up. The third case is wakeup preemption. To stop two tasks from bouncing each other off the core, a waking task preempts only when its lead exceeds sched_wakeup_granularity_us, set to 1000 microseconds by default.

Kernel code is itself preemptible in Tarn except inside sections that hold a spinlock or have disabled interrupts. Long non-preemptible sections show up as scheduling latency spikes that no amount of priority tuning can fix; the latency tracer reports any such section longer than 250 microseconds.

## CPU affinity

Each task has an affinity mask listing the cores it may use. The balancer never migrates a task outside its mask. Pinning is useful for workloads that depend on warm caches or on memory local to one NUMA node, but it removes the balancer's freedom, so a pinned task can wait on a crowded core while other cores idle.

The taskpin utility reads and changes masks:

```
taskpin --show 4312
taskpin --cores 2-5 4312
```

Child processes inherit the mask of their parent at creation time. Changing the parent later does not alter children that already exist.

## Real-time classes

Two real-time policies sit above the default class. Under RT_FIFO a task runs until it blocks or a higher real-time priority task becomes runnable; there is no slice at all. Under RT_RR tasks at the same priority level rotate with a 100 millisecond quantum. Real-time priorities range from 1 to 99, and any runnable real-time task beats every ordinary task regardless of nice value.

A runaway real-time loop could lock out everything else, including the shell needed to kill it. As a safety valve, rt_runtime_cap_us limits real-time tasks to 950000 microseconds out of every one second period, leaving 5 percent for ordinary work. Setting the cap to -1 removes the protection and is discouraged outside dedicated appliances.

## Diagnosing starvation

Starvation means a runnable task waits far longer than its share would predict. Start with runqstat, which prints per-core queue length and the longest current wait. The kernel also logs a warning tagged SCHED-W017 when any runnable task has waited longer than sched_starve_warn_ms, which is 4000 milliseconds unless changed.

| Symptom | Likely cause | First check |
| --- | --- | --- |
| One core overloaded, others idle | Narrow affinity mask | taskpin --show |
| Ordinary tasks frozen for seconds | Spinning real-time task | Real-time cap setting |
| Low priority job never finishes | Lock held by a preempted task | Lock owner in runqstat -l |

The last row describes priority inversion: a low priority task holds a lock, a medium priority task keeps it off the processor, and a high priority task waiting for the lock is stuck behind both. Tarn mitigates this with priority inheritance on kernel mutexes, temporarily lending the waiter's priority to the lock holder until the lock is released.
