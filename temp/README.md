# os_assignment2

## Build and Run
use `make` to make the file
use `./buffer_sim` to run the program with the default seed of 42
use `./buffer_sim -s <seed>` to run the program with a specific seed
use `./test.sh` to build, run with seed=42, and write the logs and summary

## 1. The predicates: 

*What are the distinct wait conditions in this problem and what does each of the four threads wait on?*

There are three distinct wait conditions for this producer/consumer assignment.
First, both producers have a wait condition based on whether the buffer is full
or not. If the buffer is full, they cannot add items to it. The second wait
condition is that the even_consumer waits on an even item to exist. The third wait condition is that the odd_consumer needs to wait on an odd item to exist.



## 2. Keep the conditions distinct. 

*Why is a single "an item exists" condition insufficient here, and how does your
solution let a consumer wait specifically for an odd (or even) item? If you used
condition variables, give a concrete interleaving in which one shared "not
empty" condition plus a single /signal/ would leave an eligible consumer asleep
forever.*


1. A single "an item exists" condition is insufficient because it doesn't determine whether the item is even or odd. If the buffer only had even items, it would wastefully wake up the odd consumer. 

2. My solution uses semaphores for each consumer to wait specifically on even/odd items. I have an n_even semaphore, and an n_odd semaphore. The odd producer only wakes up the odd consumer after an odd number is added to the buffer, and the even provider/consumer works the same way. This ensures the wait is specific to the type of item.

3. If both consumers relied on the same "not empty" condition, there's a possibility that the signal wakes the wrong consumer. The OS scheduler decides which thread to select. If the buffer has a new even item, it could wake up the odd consumer, leaving the even consumer asleep. 


## 3. Your Guarantee

*How does your design ensure no eligible thread is ever left blocked when its predicate becomes true?*


My design uses a post, which increments the semaphore and unblocks the eligible thread when its predicate becomes true. 
If the post occurs while the threads are busy, the semaphore keeps the correct count so the wakeup will always be tracked. Every branch of the code gets a post: a post for inserting odd and even items into the buffer, and posts for removing the odd/even item from the buffer. This ensures that nothing is left blocked.



## 4. Targeting 

*How does your design avoid repeatedly resuming a thread that still cannot proceed? Refer to your wasted-wakeup numbers, and explain what in your choice of primitives keeps them low*



To avoid repeatedly resuming a thread that can't proceed, the producer only posts the specific semaphore when the item is inserted into the buffer. This means that the item for the specific consumer is guaranteed to exist. Each post to my odd and even item semaphores equals one item from that type. Producers wait on a semaphore that posts when a slot in the buffer is available, so they won't wake up to a filled buffer. Using individual semaphores for each condition keeps the wasted wakeup count to zero. My wasted-wakeup numbers are zero for all threads, which proves this point.





## 5. Termination

*Why does each consumer consume exactly 100 items, and why can no thread be left blocked at the end?*


The providers and the consumers loop 100 times, not on a "buffer is empty" condition, and since each consumer selects exactly 1 item for each number, exactly 100 items are consumed from each consumer.. No thread can be blocked at the end because there are equal numbers of posts and waits for each semaphores, meaning every waiting semaphore returns.


## 6. Reproducibility

How is each producer's value sequence reproducible despite concurrency, and why is the interleaving still nondeterministic?

The interleaving is nondeterministic because the operating system determines which thread runs, not the code. The seed is stored in the struct for each thread. The producer's values are generated with that seed, which will always provide the same random string as long as the seed matches.  




























