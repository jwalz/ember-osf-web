import { tagName } from '@ember-decorators/component';
import ArrayProxy from '@ember/array/proxy';
import Component from '@ember/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { enqueueTask, restartableTask } from 'ember-concurrency';
import DS from 'ember-data';
import Intl from 'ember-intl/services/intl';
import Toast from 'ember-toastr/services/toast';

import { layout } from 'ember-osf-web/decorators/component';
import SubscriptionModel, { SubscriptionFrequency } from 'ember-osf-web/models/subscription';
import captureException, { getApiErrorMessage } from 'ember-osf-web/utils/capture-exception';
import template from './template';

@tagName('')
@layout(template)
export default class SubscriptionsManager extends Component {
    @service store!: DS.Store;
    @service toast!: Toast;
    @service intl!: Intl;
    // optional arguments
    subscriptionIds?: string[];

    // tracked properties
    @tracked subscriptions: ArrayProxy<SubscriptionModel> | SubscriptionModel[] | null = null;

    @enqueueTask({ on: 'didReceiveAttrs' })
    async fetchSubscriptions() {
        try {
            if (Array.isArray(this.subscriptionIds) && this.subscriptionIds.length) {
                this.subscriptions = await this.store.query('subscription', {
                    'filter[id]': this.subscriptionIds.join(','),
                });
            } else {
                this.subscriptions = await this.store.findAll('subscription');
            }
        } catch (e) {
            captureException(e);
            this.toast.error(getApiErrorMessage(e));
        }
    }

    @restartableTask
    async updateSubscriptionFrequency(
        subscription: SubscriptionModel,
        newFrequency: SubscriptionFrequency,
    ) {
        // eslint-disable-next-line no-param-reassign
        subscription.frequency = newFrequency;
        try {
            await subscription.save();
            this.toast.success(this.intl.t('osf-components.subscriptions.success'));
        } catch (e) {
            const errorMessage = this.intl.t('osf-components.subscriptions.error');
            captureException(e, { errorMessage });
            this.toast.error(getApiErrorMessage(e), errorMessage);
            subscription.rollbackAttributes();
        }
    }
}
