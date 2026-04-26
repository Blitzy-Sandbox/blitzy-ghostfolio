import { RebalancingService } from '@ghostfolio/client/services/rebalancing.service';
import { RebalancingResponse } from '@ghostfolio/common/interfaces';

import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at runtime.
// The companion `rebalancing-page.component.html` template uses `i18n` and
// `i18n-title` attributes, which the Angular compiler lowers to `$localize`
// tagged template calls in the component's compiled `consts` block. Without
// this side-effect import, instantiating the component via TestBed throws
// `ReferenceError: $localize is not defined`.
import '@angular/localize/init';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of } from 'rxjs';

import { RebalancingPageComponent } from './rebalancing-page.component';

describe('RebalancingPageComponent', () => {
  let component: RebalancingPageComponent;
  let fixture: ComponentFixture<RebalancingPageComponent>;
  let getRecommendationsSpy: jest.Mock;

  const mockResponse: RebalancingResponse = {
    recommendations: [
      {
        action: 'BUY',
        ticker: 'VTI',
        fromPct: 30,
        toPct: 40,
        rationale:
          'Increasing exposure to U.S. total market to align with your long-term retirement goal.',
        goalReference: 'retirementTargetAge'
      },
      {
        action: 'SELL',
        ticker: 'BND',
        fromPct: 25,
        toPct: 15,
        rationale:
          'Reducing bond allocation given your medium risk tolerance and 25-year time horizon.',
        goalReference: 'riskTolerance'
      },
      {
        action: 'HOLD',
        ticker: 'VXUS',
        fromPct: 20,
        toPct: 20,
        rationale:
          'International equities allocation is consistent with diversification objectives.',
        goalReference:
          "investmentGoals[0].label='International Diversification'"
      }
    ],
    summary:
      'Your portfolio is moderately drifted from target allocation. The recommended trades realign 3 positions to reduce volatility while keeping aggregate equity exposure within your stated risk tolerance.',
    warnings: [
      'Tax implications: selling BND may trigger short-term capital gains.',
      'Consider executing trades over multiple days to minimize market impact.'
    ]
  };

  beforeEach(async () => {
    getRecommendationsSpy = jest.fn().mockReturnValue(of(mockResponse));

    await TestBed.configureTestingModule({
      imports: [RebalancingPageComponent],
      providers: [
        provideHttpClient(),
        provideNoopAnimations(),
        {
          provide: RebalancingService,
          useValue: { getRecommendations: getRecommendationsSpy }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(RebalancingPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should call RebalancingService.getRecommendations on init', () => {
    expect(getRecommendationsSpy).toHaveBeenCalled();
  });

  it('should render the summary paragraph', () => {
    const summaryEl = fixture.debugElement.query(By.css('.summary'));

    expect(summaryEl).toBeTruthy();
    expect(summaryEl.nativeElement.textContent).toContain(mockResponse.summary);
  });

  it('should render every recommendation with rationale AND goalReference (AAP Gate § 0.7.5.2)', () => {
    const recommendationEls = fixture.debugElement.queryAll(
      By.css('.recommendation')
    );

    expect(recommendationEls.length).toBe(mockResponse.recommendations.length);

    mockResponse.recommendations.forEach((rec, idx) => {
      const el = recommendationEls[idx];
      const rationaleEl = el.query(By.css('.rationale'));
      const goalReferenceEl = el.query(By.css('.goal-reference'));

      expect(rationaleEl).toBeTruthy();
      expect(rationaleEl.nativeElement.textContent).toContain(rec.rationale);

      expect(goalReferenceEl).toBeTruthy();
      expect(goalReferenceEl.nativeElement.textContent).toContain(
        rec.goalReference
      );
    });
  });

  it('should render the action label for every recommendation (BUY / SELL / HOLD)', () => {
    const actionEls = fixture.debugElement.queryAll(By.css('.action'));

    expect(actionEls.length).toBe(mockResponse.recommendations.length);

    mockResponse.recommendations.forEach((rec, idx) => {
      expect(actionEls[idx].nativeElement.textContent).toContain(rec.action);
    });
  });

  it('should render the ticker for every recommendation', () => {
    const tickerEls = fixture.debugElement.queryAll(By.css('.ticker'));

    expect(tickerEls.length).toBe(mockResponse.recommendations.length);

    mockResponse.recommendations.forEach((rec, idx) => {
      expect(tickerEls[idx].nativeElement.textContent).toContain(rec.ticker);
    });
  });

  it('should render every warning entry in a distinct alert region', () => {
    const warningEls = fixture.debugElement.queryAll(By.css('.warning'));

    expect(warningEls.length).toBe(mockResponse.warnings.length);

    mockResponse.warnings.forEach((warning, idx) => {
      expect(warningEls[idx].nativeElement.textContent).toContain(warning);
    });
  });

  it('should NOT render a progress bar after data has loaded', () => {
    const progressBarEl = fixture.debugElement.query(
      By.css('mat-progress-bar')
    );

    expect(progressBarEl).toBeFalsy();
  });
});
