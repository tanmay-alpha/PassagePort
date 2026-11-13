# Virtual Memory in the Halvard Kernel

Every process on a Halvard system believes it owns a large, private, contiguous range of addresses. That belief is an illusion maintained by the kernel and the memory management unit of the processor working together. This document walks through the machinery behind the illusion and the knobs an administrator can turn when it starts to creak. Defaults quoted here are those of Halvard 4.8.

## Paging and page tables

Memory is divided into fixed-size pages, 4 KiB each on the common configuration. A virtual address is split into an offset within the page and a page number; the page number is looked up in a page table to find the physical frame that backs it. Because a flat table covering a 48-bit address space would be enormous, the table is a four-level tree, and subtrees for unused regions simply do not exist.

Each leaf entry carries permission bits (readable, writable, executable, user-accessible) along with a present bit, an accessed bit and a dirty bit. The kernel uses the accessed bit to estimate which pages are in active use and the dirty bit to know which pages must be written out before their frame can be reused.

## The translation cache

Walking four levels of tables for every memory access would be far too slow, so the processor remembers recent translations in the translation lookaside buffer, or TLB. A hit costs almost nothing. A miss forces a table walk that can touch four separate cache lines.

When the kernel changes a mapping it must invalidate stale entries, and on a multi-core machine that means interrupting every other core that might hold the old translation. These cross-core invalidations are called shootdowns, and workloads that map and unmap memory at a high rate can spend a surprising share of their time in them. Halvard batches up to 32 pending invalidations per core before sending the interrupt to soften the cost.

## Page faults

A page fault is raised when a process touches an address whose table entry is missing or forbids the access. Most faults are routine rather than errors, and they come in two kinds:

- A minor fault is resolved without any disk input: the data is already in memory, or the page only needs to be zero-filled, and the kernel merely installs a table entry.
- A major fault requires reading the contents from storage, either from a file or from the swap area, and the process sleeps until the read completes.

Memory is allocated lazily. A request for a gigabyte returns immediately, and frames are assigned only as each page is first touched. Copy-on-write follows the same pattern: after a process forks, parent and child share frames marked read-only, and a private copy is made at the moment either one writes. A fault that cannot be resolved at all, such as a write to a read-only mapping, is delivered to the process as the SIGSEGV signal. The pgfaultstat tool prints both fault counters per process, and a sustained major fault rate above a few hundred per second usually signals memory pressure.

## Swapping and reclaim

When free memory falls below a low watermark, a background reclaim thread named kreclaimd starts scanning for pages to evict. Clean file-backed pages can simply be dropped, since they can be read again later. Anonymous pages, such as heap and stack, have no file behind them and must be written to the swap area before the frame is freed.

The balance between those two choices is controlled by vm_swap_eagerness, an integer from 0 to 200 with a default of 40. Low values make the kernel shrink the file cache first; high values make it willing to push anonymous memory to swap early. Dirty file pages are flushed in the background once they exceed vm_dirty_flush_pct of total memory, which is 12 percent by default.

If reclaim cannot keep up, the system enters thrashing: processes fault pages in only to have them evicted again moments later, and almost no useful work gets done even though the processors look busy.

## Overcommit

Because of lazy allocation, the kernel can promise more memory than it has. The policy is chosen by vm_overcommit_policy:

| Value | Behavior |
| --- | --- |
| heuristic | Refuse only obviously absurd requests (the default) |
| strict | Cap total commitments at swap plus a percentage of physical memory |
| always | Never refuse a request |

Under the strict policy the percentage comes from vm_commit_ratio_pct, default 50, and an allocation that would exceed the cap fails right away with ENOMEM. That is easier for a program to handle than being killed later, which is why databases often prefer strict accounting.

## The out-of-memory killer

When reclaim fails and there is no swap left, the kernel must free memory by force. It scores every process, mostly by how much memory killing it would release, and sends SIGKILL to the one with the highest score. The event is logged with the tag MEM-E031 together with a table of the candidates and their scores.

Administrators can shift the choice with oom_badness_bias, a per-process value from -1000 to 1000 that is added to the score. A value of -1000 exempts the process entirely. Exempting too many processes is dangerous, because the killer may then find nothing worth killing and the machine will hang instead.

## Huge pages

A single TLB entry can also map a 2 MiB huge page, covering 512 times more memory than a regular entry. Programs with large heaps, such as in-memory caches and virtual machine monitors, see fewer TLB misses as a result. Halvard offers two routes: a reserved pool sized by hugepage_pool_count, which is set aside at boot and never swapped, and transparent promotion, where a background thread collapses runs of small pages into huge ones.

Transparent promotion has costs. Compacting memory to find a contiguous 2 MiB run can stall an allocation for tens of milliseconds, and a sparsely used huge page wastes memory that 4 KiB pages would have left free. Latency-sensitive services often disable it and use the reserved pool instead.

## Tuning checklist

Change one parameter at a time and watch the major fault rate and reclaim activity for at least a full business cycle before judging the result. Prefer strict commitment accounting on database hosts, lower swap eagerness for services that keep large heaps, and reserve huge pages only for programs that were built to request them.
