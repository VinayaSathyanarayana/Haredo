import { Haredo, haredo } from '../../src/haredo';
import { setup, teardown, checkQueue, getSingleMessage } from './helpers/amqp';
import { delay } from '../../src/utils';
import { spy, SinonSpy, stub } from 'sinon';

import * as sinonChai from 'sinon-chai';
import * as chaiAsPromised from 'chai-as-promised';
import { use, expect } from 'chai';
import { isConsumerClosed } from './helpers/utils';
import { FailureBackoff } from '../../src/backoffs';

use(sinonChai);
use(chaiAsPromised);

describe('integration/consumer', () => {
    let rabbit: Haredo;
    beforeEach(async () => {
        await setup();
        rabbit = haredo({
            connection: 'amqp://localhost:5672/test'
        });
    });
    afterEach(async () => {
        rabbit.close();
        await teardown();
    });
    it('should setup queue when subscribe is called', async () => {
        await rabbit.queue('test').subscribe(() => {});
        await checkQueue('test');
    });
    it('should receive a message', async () => {
        const cbSpy = spy()
        await rabbit.queue('test2').subscribe(cbSpy);
        await rabbit.queue('test2').publish('test');
        await delay(20);
        expect(cbSpy).to.be.calledOnce;
        expect(cbSpy).to.be.calledWithMatch({ data: 'test' });
    });
    it('should close consumer when .close is called', async () => {
        const consumer = await rabbit.queue('test').subscribe(() => { });
        expect(await isConsumerClosed('test')).to.be.false;
        await consumer.close();
        expect(await isConsumerClosed('test')).to.be.true;
    });
    it('should close consumer if haredo gets closed', async () => {
        const consumer = await rabbit.queue('test').subscribe(() => { });
        await rabbit.close();
        expect(consumer.isClosed).to.be.true;
    });
    it('should wait for message to be acked before closing consumer', async () => {
        const consumer = await rabbit.queue('test').subscribe(async () => {
            await delay(200);
        });
        await rabbit.queue('test').confirm().publish('test');
        await delay(20);
        await consumer.close();
        await expectFail(getSingleMessage('test'));
    });
    it('should mark isHandled in middleware', async () => {
        let isHandledBefore: boolean;
        let isHandledAfter: boolean;
        const consumer = await rabbit.queue('test')
            .use(async ({ isHandled }, next) => {
                isHandledBefore = isHandled();
                await next();
                isHandledAfter = isHandled();
            })
            .subscribe(async () => {});
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        await consumer.close();
        expect(isHandledBefore).to.equal(false);
        expect(isHandledAfter).to.equal(true);
    });
    it('should work with non-promise-returning middleware', async () => {
        let isHandledBefore: boolean;
        let isHandledAfter: boolean;
        const consumer = await rabbit.queue('test')
            .use(({ isHandled }, next) => {
                isHandledBefore = isHandled();
                next().then(() => isHandledAfter = isHandled());
            })
            .subscribe(async () => { });
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        await consumer.close();
        expect(isHandledBefore).to.equal(false);
        expect(isHandledAfter).to.equal(true);
    });
    it('should nack if subscribe callback fails', async () => {
        let nackSpy: SinonSpy;
        await rabbit.queue('test')
            .subscribe(async (message) => {
                nackSpy = spy(message, 'nack')
                throw new Error('whoopsiedaisy');
            });
        await rabbit.queue('test').confirm().publish('test');
        await delay(100);
        expect(nackSpy.calledOnce).to.be.true;
    });
    it('should nack if subscribe middleware fails', async () => {
        let nackSpy: SinonSpy;
        await rabbit.queue('test')
            .use((message) => {
                nackSpy = spy(message, 'nack');
                throw new Error();
            })
            .subscribe(() => {});
        await rabbit.queue('test').confirm().publish('test');
        await delay(100);
        expect(nackSpy.calledOnce).to.be.true;
    });
    it('should not autoack when it is disabled', async () => {
        let isMessageHandled: () => boolean;
        await rabbit.queue('test')
            .autoAck(false)
            .subscribe(({ isHandled, ack }) => {
                isMessageHandled = isHandled;
                setTimeout(async () => {
                    ack();
                }, 200);
            });
        await rabbit.queue('test').confirm().publish('test');
        await delay(100);
        expect(isMessageHandled()).to.be.false;
        await delay(120);
        expect(isMessageHandled()).to.be.true;
    });
    it('should wait for all messages to be handled before closing consumer', async () => {
        let hasDelayPassed = false;
        const consumer = await rabbit.queue('test')
            .subscribe(async () => {
                await delay(200);
                hasDelayPassed = true;
            });
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        await consumer.close();
        expect(hasDelayPassed).to.be.true;
        await expectFail(getSingleMessage('test'));
    });
    it('should call next automatically when not called ', async () => {
        const callStub = stub();
        await rabbit.queue('test')
            .use(() => {})
            .subscribe(callStub);
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        expect(callStub).to.have.been.calledOnce;
    });
    it('should not call message callback when message his handled in middleware', async () => {
        const callStub = stub();
        await rabbit.queue('test')
            .use(async ({ ack }, next) => { ack(); await next() })
            .subscribe(callStub);
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        expect(callStub).to.not.have.been.called;
    });
    it('should call backoff functions', async () => {
        const backoff = {
            ack: spy(),
            take: stub().returns(Promise.resolve()),
            pass: stub(),
            nack: spy(),
            fail: spy()
        } as FailureBackoff;
        const callStub = stub().rejects(new Error('whoopsiedaisy')).onFirstCall().resolves();
        await rabbit.queue('test')
            .backoff(backoff)
            .subscribe(callStub);
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        expect(backoff.ack).to.have.been.calledOnce;
        expect(backoff.take).to.have.been.calledOnce;
        expect(backoff.pass).to.have.been.calledOnce;
        expect(backoff.nack).to.not.have.been.called;
        expect(backoff.fail).to.not.have.been.called;
        await rabbit.queue('test').confirm().publish('test');
        await delay(50);
        expect(backoff.nack).to.have.been.called;
        expect(backoff.fail).to.have.been.called;
    });
});

export const expectFail = async (promise: Promise<any>, pattern?: string) => {
    try {
        await promise;
        throw new Error('Expected promise to be rejected but it was resolved');
    } catch (e) {
        if (pattern) {
            if (!e.message.includes(pattern)) {
                throw new Error(`Expected promise to be rejected with an error matching ${ pattern }, but it was rejected with ${ e }`);
            }
        }
    }
}
