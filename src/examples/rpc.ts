import { Queue } from '../queue';
import { Haredo } from '../haredo';
import { delay } from '../utils';

export const main = async () => {
    console.log('starting example');
    const haredo = new Haredo({
        connection: 'amqp://guest:guest@localhost:5672/'
    });
    await haredo.connect();
    const queue = new Queue<number[]>('sum').expires(2000);
    await haredo.queue(queue).subscribe((data, msg) => {
        console.log('Calculating sum', data.join(' + '));
        return (data.reduce((acc, item) => acc + item));
    });
    let i = 1;
    while (true) {
        const result = await haredo.queue(queue)
            .rpc([i - 1, i, i + 1]);
        i += 1;
        console.log('Sum is', result);
        await delay(2000);
    }
};

process.nextTick(() => main());